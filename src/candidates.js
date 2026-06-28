const { cosine } = require('./embeddings');
const taste = require('./taste');

const RELATED_CACHE_TTL = 30 * 86400;

function mergeCandidates(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const candidate of list || []) {
      if (!candidate?.tmdb_id) continue;
      const previous = byId.get(candidate.tmdb_id);
      if (!previous) {
        byId.set(candidate.tmdb_id, {
          ...candidate,
          score: candidate.score || 0,
          sources: [...(candidate.sources || [])],
        });
      } else {
        previous.score += candidate.score || 0;
        previous.sources.push(...(candidate.sources || []));
      }
    }
  }
  return Array.from(byId.values());
}

function extractJSON(text) {
  const raw = String(text || '');
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          start = -1;
        }
      }
    }
  }
  return {};
}

function topKeys(map = {}, limit = 5) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => Number(key) || key);
}

async function generateEssenceTitles(profile, type, callAI) {
  if (!callAI) return [];
  const media = type === 'movie' ? 'movies' : 'series';
  const system = 'You are a film and TV curator. Find essence bridges: the same emotional core in a different package. Reply with valid JSON only.';
  const user = `Strong seeds: ${(profile.topSeeds || []).slice(0, 12).map(s => s.title).join(', ')}
Strong TMDB genres: ${topKeys(profile.genres, 6).join(', ')}
Frequent languages: ${topKeys(profile.languages, 4).join(', ')}

List 30 ${media} that are good essence bridges to watch now, avoiding obvious franchises.
Format: {"items":[{"title":"...","year":2014}]}`;

  const raw = await callAI(system, user);
  const items = extractJSON(raw)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .filter(item => item?.title)
    .slice(0, 30)
    .map(item => ({ title: item.title, year: item.year ? Number(item.year) : undefined }));
}

async function groundTitles(rawTitles, type, tmdb) {
  const out = [];
  for (const title of rawTitles || []) {
    const results = await tmdb.searchTitle(title.title, title.year, type);
    const match = tmdb.pickBestMatch(results, { title: title.title, year: title.year, type });
    if (!match) continue;
    out.push(toCandidate(match, { kind: 'ai' }, 0.9));
  }
  return out;
}

function toCandidate(item, source, score = 1) {
  return {
    tmdb_id: item.id,
    title: item.title || item.name || '',
    year: parseInt((item.release_date || item.first_air_date || '').slice(0, 4), 10) || 0,
    vote_average: item.vote_average || 0,
    vote_count: item.vote_count || 0,
    genre_ids: item.genre_ids || [],
    original_language: item.original_language || '',
    score,
    sources: [source],
  };
}

async function discoverCandidates({ profile, type, catalogId }, tmdb) {
  const genres = topKeys(profile.genres, 3).map(Number).filter(Boolean);
  const keywords = topKeys(profile.keywords, 5).map(Number).filter(Boolean);
  const language = topKeys(profile.languages, 1)[0];
  const date = new Date();
  const opts = { genres, keywords, language, voteCountGte: 50, sortBy: 'popularity.desc' };
  if (catalogId === 'new-for-you') {
    date.setMonth(date.getMonth() - 18);
    opts.dateGte = date.toISOString().slice(0, 10);
    opts.sortBy = type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc';
  }
  if (catalogId === 'discovery') {
    opts.sortBy = 'vote_count.desc';
  }

  const items = [];
  const queries = [{ ...opts }];
  for (const genre of genres.slice(0, 3)) {
    queries.push({ ...opts, genres: [genre] });
  }
  if (catalogId === 'discovery' && genres.length) {
    queries.push({ ...opts, genres: [], withoutGenres: [genres[0]] });
  }

  for (const query of queries) {
    for (let page = 1; page <= 2; page++) {
      const pageItems = await tmdb.discover(type, { ...query, page });
      items.push(...pageItems);
      if (!pageItems.length || pageItems.length < 20) break;
    }
  }

  if (items.length < 80) {
    for (let page = 1; page <= 2; page++) {
      const broadItems = await tmdb.discover(type, {
        voteCountGte: 80,
        sortBy: 'popularity.desc',
        page,
      });
      items.push(...broadItems);
      if (!broadItems.length || broadItems.length < 20) break;
    }
  }
  return items.map(item => toCandidate(item, { kind: 'discover' }, 1));
}

async function relatedCandidates({ seeds, type }, tmdb) {
  const candidates = [];
  for (const seed of (seeds || []).slice(0, 5)) {
    let recs = [];
    let similar = [];
    try {
      [recs, similar] = await Promise.all([
        tmdb.getRecommendations(seed.tmdbId, type, 1),
        tmdb.getSimilar(seed.tmdbId, type),
      ]);
    } catch (err) {
      console.warn(`[candidates] falha em seed ${seed.title || seed.tmdbId}:`, err.message);
      continue;
    }
    for (const item of recs || []) candidates.push(toCandidate(item, { kind: 'recs', seed: seed.title }, 1));
    for (const item of similar || []) candidates.push(toCandidate(item, { kind: 'similar', seed: seed.title }, 0.7));
  }
  return candidates;
}

// Fonte semântica: vizinhos do vetor do usuário entre os embeddings cacheados.
// Degrada para [] sem userVec ou sem linhas em media_embeddings.
async function embeddingCandidates({ userVec, type }, deps = {}) {
  if (!Array.isArray(userVec) || !userVec.length) return [];
  const db = deps.db || require('./db').db;

  let rows;
  try {
    const res = await db.execute({
      sql: 'SELECT tmdb_id, vec FROM media_embeddings WHERE type=?',
      args: [type],
    });
    rows = res.rows || [];
  } catch {
    return [];
  }
  if (!rows.length) return [];

  const scored = [];
  for (const row of rows) {
    let vec;
    try {
      vec = JSON.parse(row.vec);
    } catch {
      continue;
    }
    if (!Array.isArray(vec) || !vec.length) continue;
    const sim = cosine(userVec, vec);
    if (sim <= 0) continue;
    scored.push({ tmdb_id: Number(row.tmdb_id), sim });
  }

  scored.sort((a, b) => b.sim - a.sim);
  return scored
    .slice(0, 40)
    .map(item => toCandidate({ id: item.tmdb_id }, { kind: 'embedding' }, 0.9));
}

async function readRelatedCache(type, traktId, db) {
  const res = await db.execute({
    sql: 'SELECT payload, updated_at FROM trakt_related_cache WHERE type=? AND trakt_id=?',
    args: [type, traktId],
  }).catch(() => ({ rows: [] }));
  const row = res.rows?.[0];
  if (!row) return null;
  const age = Math.floor(Date.now() / 1000) - Number(row.updated_at || 0);
  if (age < 0 || age >= RELATED_CACHE_TTL) return null;
  try {
    const payload = JSON.parse(row.payload || 'null');
    return Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function writeRelatedCache(type, traktId, payload, db) {
  await db.execute({
    sql: `INSERT INTO trakt_related_cache (type, trakt_id, payload, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(type, trakt_id)
          DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
    args: [type, traktId, JSON.stringify(payload || []), Math.floor(Date.now() / 1000)],
  }).catch(() => {});
}

// /related cache-first (TTL 30d). Só chama o Trakt em cache-miss; grava o resultado.
async function relatedForSeed(type, traktId, trakt, db) {
  const cached = await readRelatedCache(type, traktId, db);
  if (cached) return cached;
  const fresh = await trakt.getRelated(type, traktId);
  if (Array.isArray(fresh) && fresh.length) {
    await writeRelatedCache(type, traktId, fresh, db);
    return fresh;
  }
  return Array.isArray(fresh) ? fresh : [];
}

// Item /related do Trakt -> candidato, usando o ids.tmdb DO RELACIONADO.
function relatedItemToCandidate(item, type, seedTitle) {
  const tmdbId = item?.ids?.tmdb;
  if (!tmdbId) return null;
  const dateKey = type === 'movie' ? 'release_date' : 'first_air_date';
  return toCandidate({
    id: tmdbId,
    title: item.title || item.name || '',
    [dateKey]: item.year ? String(item.year) : '',
    vote_average: item.rating || 0,
    vote_count: item.votes || 0,
    genre_ids: taste.normalizeGenreIds(item.genres || []),
    original_language: item.language || '',
  }, { kind: 'trakt_related', seed: seedTitle }, 1);
}

// Fonte CF item-item do Trakt, cacheada. Degrada para [] sem dados/erro/bloqueio.
async function traktRelatedCandidates({ topWatched, type }, deps = {}) {
  const seeds = (topWatched || []).filter(seed => seed && seed.traktId);
  const trakt = deps.trakt;
  if (!seeds.length || !trakt || typeof trakt.getRelated !== 'function') return [];
  const db = deps.db || require('./db').db;

  const out = [];
  for (const seed of seeds) {
    try {
      const related = await relatedForSeed(type, seed.traktId, trakt, db);
      for (const item of related || []) {
        const candidate = relatedItemToCandidate(item, type, seed.title);
        if (candidate) out.push(candidate);
      }
    } catch {
      // bloqueio/erro numa semente não derruba a fonte
    }
  }
  return out;
}

async function buildCandidates({ profile, seeds, type, catalogId, userVec, topWatched }, deps) {
  const { tmdb, callAI } = deps;
  const [discoverList, relatedList, traktRelatedList, embeddingList, ftsList] = await Promise.all([
    discoverCandidates({ profile, type, catalogId }, tmdb),
    relatedCandidates({ seeds, type }, tmdb),
    traktRelatedCandidates({ topWatched, type }, deps),
    embeddingCandidates({ userVec, type }, deps),
    ftsCandidates({ profile, type }, deps),
  ]);

  let aiList = [];
  if (catalogId !== 'new-for-you' && callAI) {
    try {
      const titles = await generateEssenceTitles(profile, type, callAI);
      aiList = await groundTitles(titles, type, tmdb);
    } catch (err) {
      console.warn(`[candidates] IA-essência falhou ${catalogId}/${type}:`, err.message);
    }
  }

  // Rich sources first; sparse embedding/FTS sources last so they do not overwrite metadata.
  return mergeCandidates(discoverList, relatedList, aiList, traktRelatedList, embeddingList, ftsList);
}

function sanitizeFtsTerm(term) {
  return String(term || '').replace(/["()*:^]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildFtsMatch(keywords, limit = 8) {
  const terms = (keywords || [])
    .map(sanitizeFtsTerm)
    .filter(term => term.length >= 3)
    .slice(0, limit);
  if (!terms.length) return '';
  return terms.map(term => `"${term}"`).join(' OR ');
}

async function ftsCandidates({ profile, type }, deps = {}) {
  const db = deps.db || require('./db').db;
  const match = buildFtsMatch(topKeys((profile && profile.keywords) || {}, 8).map(String));
  if (!match) return [];
  try {
    const res = await db.execute({
      sql: 'SELECT tmdb_id FROM media_fts WHERE type=? AND text MATCH ? LIMIT 60',
      args: [type, match],
    });
    return (res.rows || [])
      .map(row => toCandidate({ id: Number(row.tmdb_id) }, { kind: 'fts' }, 0.85))
      .filter(candidate => candidate.tmdb_id);
  } catch {
    return [];
  }
}

// Cross-type AI essence: usa sementes de outro tipo (série→filme ou filme→série)
// para gerar candidatos do tipo alvo via generateEssenceTitles.
// Só deve ser chamado em cold start (seeds do tipo alvo < 3).
// Degrada para [] sem callAI, sem tmdb, sem otherTypeSeeds ou em erro.
async function crossTypeEssenceCandidates({ otherTypeProfile, otherTypeSeeds, targetType }, deps = {}) {
  const { callAI, tmdb } = deps;
  if (!callAI || !tmdb) return [];
  if (!otherTypeSeeds || !otherTypeSeeds.length) return [];

  // Usa o perfil do outro tipo — gêneros/idiomas/topSeeds refletem o gosto real;
  // targetType garante que o prompt peça filmes ou séries conforme o caso.
  const profile = otherTypeProfile || {
    topSeeds: otherTypeSeeds.map(s => ({ title: s.title || '' })),
    genres: {},
    languages: {},
  };

  try {
    const titles = await generateEssenceTitles(profile, targetType, callAI);
    const raw = await groundTitles(titles, targetType, tmdb);
    // Relabela a fonte para distinguir de candidatos IA normais
    return raw.map(c => ({
      ...c,
      sources: [{ kind: 'cross_essence', seed: 'cross_type' }],
    }));
  } catch (err) {
    console.warn(`[candidates] crossTypeEssenceCandidates ${targetType} falhou:`, err.message);
    return [];
  }
}

// Fallback cold start: trending semanal quando não há histórico suficiente.
// Filtra por piso mínimo de votos (≥50). Degrada para [] sem deps.tmdb ou em erro.
async function coldStartCandidates({ type }, deps = {}) {
  const tmdb = deps.tmdb;
  if (!tmdb || typeof tmdb.getTrending !== 'function') return [];
  try {
    const items = await tmdb.getTrending(type);
    return items
      .filter(item => (item.vote_count || 0) >= 50)
      .map(item => toCandidate(item, { kind: 'trending' }, 0.8));
  } catch (err) {
    console.warn(`[candidates] coldStartCandidates falhou ${type}:`, err.message);
    return [];
  }
}

module.exports = {
  mergeCandidates,
  generateEssenceTitles,
  groundTitles,
  buildCandidates,
  coldStartCandidates,
  crossTypeEssenceCandidates,
  embeddingCandidates,
  traktRelatedCandidates,
  ftsCandidates,
  buildFtsMatch,
  toCandidate,
  extractJSON,
};
