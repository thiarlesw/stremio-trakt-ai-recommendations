require('dotenv').config();
const crypto = require('crypto');
const { db, initSchema } = require('./db');
const trakt = require('./trakt');
const tmdb = require('./tmdb');
const sessions = require('./sessions');
const taste = require('./taste');
const candidatesMod = require('./candidates');
const score = require('./score');
const curator = require('./curator');
const { simpleCallAI } = require('./llm');
const feedback = require('./feedback');
const CURATOR_TIMEOUT_MS = Number(process.env.AI_CURATOR_TIMEOUT_MS) || 120000;
const curatorCallAI = (systemPrompt, userPrompt) => simpleCallAI(systemPrompt, userPrompt, { timeoutMs: CURATOR_TIMEOUT_MS });
const { recordDebug } = require('./debug');
const { buildWatchedSets, eventsFromTrakt, negativeEventsFromTrakt, positiveEventsFromPlayback, enrichEventsFromCache, daysSince } = require('./events');
const memory = require('./memory');
const mediaCache = require('./mediaCache');
const embeddings = require('./embeddings');
const {
  loadColdStartSeeds,
  loadUserRatingsForType,
  buildUserRatingEvents,
  injectExternalSignals,
} = require('./coldStartUtils');

const TARGET = 24;
const MIN = 18;
const CURATION_INPUT = 50;
// "New For You" means recent releases. The age cap applies to every source,
// not just TMDB discover: recs/similar/trakt_related/embedding also respect it.
const NEW_FOR_YOU_MAX_AGE_YEARS = 2;
const TRAKT_CACHE_TTL = 6 * 3600; // 6h: watched/playback cache by session
const SESSION_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CATALOGS = [
  { id: 'watch-next', type: 'movie' },
  { id: 'watch-next', type: 'series' },
  { id: 'discovery', type: 'movie' },
  { id: 'discovery', type: 'series' },
  { id: 'new-for-you', type: 'movie' },
  { id: 'new-for-you', type: 'series' },
];

function catalogsForBuild(options = {}) {
  if (!options.catalog && !options.type) return CATALOGS;
  return CATALOGS.filter(cat =>
    (!options.catalog || cat.id === options.catalog) &&
    (!options.type || cat.type === options.type)
  );
}

function emptyDebug() {
  return {
    seeds: 0,
    candidates_raw: 0,
    candidates_filtered: 0,
    sources: {},
    dropped: { watched: 0, shown: 0, hidden: 0 },
    scored: 0,
    curated: 0,
    backfilled: 0,
    saved: 0,
    ai_failed: false,
    error: null,
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

async function acquireLock(sessionId) {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db.execute({
    sql: 'SELECT locked_at FROM builder_locks WHERE session_id=?',
    args: [sessionId],
  });

  if (existing.rows.length) {
    const age = now - Number(existing.rows[0].locked_at || 0);
    if (age >= 0 && age < 7200) {
      console.log(`[builder] sessão ${sessionId}: lock ativo (${Math.round(age / 60)}min), skip`);
      return false;
    }
    await db.execute({
      sql: 'UPDATE builder_locks SET locked_at=? WHERE session_id=?',
      args: [now, sessionId],
    });
    return true;
  }

  await db.execute({
    sql: 'INSERT INTO builder_locks (session_id, locked_at) VALUES (?, ?)',
    args: [sessionId, now],
  });
  return true;
}

async function getShownIds(sessionId, type) {
  const histCutoff = Math.floor(Date.now() / 1000) - 45 * 86400;
  const res = await db.execute({
    sql: 'SELECT tmdb_id FROM generated_history WHERE session_id=? AND type=? AND generated_at>?',
    args: [sessionId, type, histCutoff],
  });
  return new Set(res.rows.map(row => Number(row.tmdb_id)));
}

function countSources(debug, pool) {
  for (const candidate of pool) {
    for (const source of candidate.sources || []) {
      debug.sources[source.kind] = (debug.sources[source.kind] || 0) + 1;
    }
  }
}

function filterCandidates(pool, { watchedSet, shownIds, hiddenIds, coldSeedIds, minVotes = 0, minVotesEmbedding = null, minYear = 0, debug }) {
  const out = [];
  for (const candidate of pool) {
    if (!candidate.tmdb_id) continue;
    if (watchedSet.has(candidate.tmdb_id)) {
      debug.dropped.watched += 1;
      continue;
    }
    if (shownIds.has(candidate.tmdb_id)) {
      debug.dropped.shown += 1;
      continue;
    }
    if (hiddenIds.has(candidate.tmdb_id)) {
      debug.dropped.hidden += 1;
      continue;
    }
    // Correction A: cold_start_seeds são títulos que o usuário já conhece/gosta —
    // não devem aparecer nas recomendações.
    if (coldSeedIds && coldSeedIds.has(candidate.tmdb_id)) {
      debug.dropped.cold_seed = (debug.dropped.cold_seed || 0) + 1;
      continue;
    }
    // Piso de votos por-fonte: candidatos com vouch semântico ('embedding') usam um
    // piso bem menor (minVotesEmbedding) para a joia indie de alma sobreviver — mas o
    // lixo obscuro abaixo desse piso continua morrendo.
    const isEmbedding = (candidate.sources || []).some(source => source.kind === 'embedding');
    const voteFloor = (isEmbedding && minVotesEmbedding != null) ? minVotesEmbedding : minVotes;
    if (voteFloor && (candidate.vote_count || 0) < voteFloor) {
      debug.dropped.lowvotes = (debug.dropped.lowvotes || 0) + 1;
      continue;
    }
    if (minYear && candidate.year && candidate.year < minYear) {
      debug.dropped.old = (debug.dropped.old || 0) + 1;
      continue;
    }
    out.push(candidate);
  }
  return out;
}

function cloneDebugDropped(debug) {
  return { ...(debug?.dropped || {}) };
}

function restoreDebugDropped(debug, dropped) {
  if (debug) debug.dropped = { ...dropped };
}

function chooseFilteredCandidates(pool, opts) {
  const strict = filterCandidates(pool, opts);
  if (strict.length >= (opts.minNeeded || MIN)) return strict;

  const before = cloneDebugDropped(opts.debug);
  const relaxed = filterCandidates(pool, { ...opts, shownIds: new Set() });
  if (relaxed.length > strict.length) {
    restoreDebugDropped(opts.debug, before);
    opts.debug.relaxed_shown = true;
    opts.debug.dropped.shown_relaxed = (opts.shownIds || new Set()).size;
    return relaxed;
  }

  return strict;
}

// Ordem final: itens curados pelo GLM primeiro (com why), depois BACKFILL honesto
// com o ranking determinístico ainda não escolhido — sem why de IA (_backfill:true).
// Garante que a prateleira nunca trave nem fique velha por soluço do GLM, sem
// disfarçar rec local de curadoria IA.
function finalOrder(curated, ranked, { target = 24 } = {}) {
  const seen = new Set();
  const curatedRefs = [];
  for (const item of curated || []) {
    const id = item.candidate?.tmdb_id;
    if (!id || seen.has(id)) continue;
    curatedRefs.push(item);
    seen.add(id);
  }

  // MMR final: dos escolhidos pelo GLM, fica com os `target` mais variados por alma
  // (cada spot único). O GLM decide quem é elegível; isto só arruma a variedade.
  const refs = score.diversifyRefs(curatedRefs, target);

  // Backfill honesto com o ranking determinístico ainda não usado (sem why de IA).
  for (const candidate of ranked || []) {
    if (refs.length >= target) break;
    const id = candidate?.tmdb_id;
    if (!id || seen.has(id)) continue;
    refs.push({ candidate, why: '', _backfill: true });
    seen.add(id);
  }

  return refs;
}

function didCuratorFail(catalogId, curated) {
  return !curated || curated.length === 0;
}

function catalogItemFromCandidate(candidate, why) {
  if (!candidate?.imdb_id) return null;
  return {
    tmdb_id: candidate.tmdb_id,
    imdb_id: candidate.imdb_id,
    title: candidate.title,
    year: candidate.year,
    poster: candidate.poster,
    backdrop: candidate.backdrop,
    vote_average: candidate.vote_average,
    genres: candidate.genres || [],
    runtime: candidate.runtime || null,
    why,
  };
}

async function enrichItems(refs, type) {
  const items = [];
  for (const { candidate, why } of refs) {
    const cachedItem = catalogItemFromCandidate(candidate, why);
    if (cachedItem) {
      items.push(cachedItem);
      if (items.length >= TARGET) break;
      continue;
    }
    await sleep(100);
    const details = await tmdb.getDetails(candidate.tmdb_id, type);
    if (!details?.imdb_id) continue;
    items.push({ ...details, why });
    if (items.length >= TARGET) break;
  }
  return items;
}

async function saveCatalog(sessionId, catalogId, type, items) {
  const builtAt = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO recommendations (session_id, catalog_id, type, items, built_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, catalog_id, type)
          DO UPDATE SET items=excluded.items, built_at=excluded.built_at`,
    args: [sessionId, catalogId, type, JSON.stringify(items), builtAt],
  });

  for (const item of items) {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO generated_history (session_id, type, tmdb_id, generated_at) VALUES (?, ?, ?, ?)',
      args: [sessionId, type, item.tmdb_id, builtAt],
    });
  }

  const histCutoff = Math.floor(Date.now() / 1000) - 45 * 86400;
  await db.execute({
    sql: 'DELETE FROM generated_history WHERE session_id=? AND type=? AND generated_at<?',
    args: [sessionId, type, histCutoff],
  });

  return builtAt;
}

async function saveTasteProfile(sessionId, type, profile, builtAt) {
  await db.execute({
    sql: `INSERT INTO taste_profiles (session_id, type, profile_json, built_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, type)
          DO UPDATE SET profile_json=excluded.profile_json, built_at=excluded.built_at`,
    args: [sessionId, type, JSON.stringify(profile), builtAt],
  });
}

async function readTraktCache(sessionId, type, kind, deps = {}) {
  const dbi = deps.db || db;
  const res = await dbi.execute({
    sql: 'SELECT payload, updated_at FROM trakt_cache WHERE session_id=? AND type=? AND kind=?',
    args: [sessionId, type, kind],
  }).catch(() => ({ rows: [] }));
  const row = res.rows?.[0];
  if (!row) return null;
  let payload = null;
  try {
    payload = JSON.parse(row.payload || 'null');
  } catch {
    return null;
  }
  const age = Math.floor(Date.now() / 1000) - Number(row.updated_at || 0);
  return { payload: Array.isArray(payload) ? payload : [], age };
}

async function writeTraktCache(sessionId, type, kind, payload, deps = {}) {
  const dbi = deps.db || db;
  await dbi.execute({
    sql: `INSERT INTO trakt_cache (session_id, type, kind, payload, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, type, kind)
          DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
    args: [sessionId, type, kind, JSON.stringify(payload || []), Math.floor(Date.now() / 1000)],
  }).catch(() => {});
}

// Cache-first dos sinais do Trakt: se houver cache fresco (TTL 6h), NÃO re-pagina o
// histórico. Em cache-miss busca e grava; se a busca falhar/bloquear (vazio), cai
// para o cache existente mesmo velho. fetcher e db são injetáveis para testes.
async function fetchTraktSignal(sessionId, type, kind, fetcher, deps = {}) {
  const cached = await readTraktCache(sessionId, type, kind, deps);
  if (cached && cached.age >= 0 && cached.age < TRAKT_CACHE_TTL) return cached.payload;

  const fetched = await fetcher();
  if (Array.isArray(fetched) && fetched.length) {
    await writeTraktCache(sessionId, type, kind, fetched, deps);
    return fetched;
  }
  if (cached && Array.isArray(cached.payload) && cached.payload.length) return cached.payload;
  return Array.isArray(fetched) ? fetched : [];
}

async function loadSignals(sessionId, accessToken) {
  const [
    watchedMovies,
    watchedShows,
    playbackMovies,
    playbackShows,
  ] = await Promise.all([
    fetchTraktSignal(sessionId, 'movie', 'watched', () => trakt.getWatched(accessToken, 'movie')),
    fetchTraktSignal(sessionId, 'series', 'watched', () => trakt.getWatched(accessToken, 'series')),
    fetchTraktSignal(sessionId, 'movie', 'playback', () => trakt.getPlayback(accessToken, 'movie')),
    fetchTraktSignal(sessionId, 'series', 'playback', () => trakt.getPlayback(accessToken, 'series')),
  ]);

  return {
    watched: { movie: watchedMovies, series: watchedShows },
    playback: { movie: playbackMovies, series: playbackShows },
    watchedSets: buildWatchedSets(watchedMovies, watchedShows),
  };
}

// Top sementes assistidas com {traktId, tmdbId, weight} a partir de signals.watched.
// Usa o trakt id que já vem em /sync/watched (sem lookup extra tmdb->trakt).
function buildTopWatched(watchedItems, type, limit = 15) {
  const key = type === 'movie' ? 'movie' : 'show';
  const scored = [];
  for (const item of watchedItems || []) {
    const media = item[key];
    const traktId = media?.ids?.trakt;
    const tmdbId = media?.ids?.tmdb;
    if (!traktId || !tmdbId) continue;
    const weight = taste.eventWeight({
      plays: item.plays || 1,
      daysSince: daysSince(item.last_watched_at),
      completion: 1,
      source: 'watched',
    });
    scored.push({ traktId, tmdbId, title: media.title || media.name || '', weight });
  }
  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, limit);
}

async function buildTypeContexts(sessionId, signals) {
  const contexts = {};
  for (const type of ['movie', 'series']) {
    // Positivos = scrobbles (watched) + playback alto (≥70%, ainda não scrobblado).
    const watchedEvents = eventsFromTrakt(signals.watched[type], type);
    const playbackPositives = positiveEventsFromPlayback(signals.playback[type], type, signals.watchedSets[type]);
    const events = [...watchedEvents, ...playbackPositives]
      .sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0));
    const negativeEvents = negativeEventsFromTrakt(signals.playback[type], type);
    await memory.recordUserEvents(sessionId, type, 'positive_signal', events);
    await memory.recordUserEvents(sessionId, type, 'negative_signal', negativeEvents);
    await memory.markAcceptedFromWatched(sessionId, type, signals.watchedSets[type]);

    // Enriquece eventos com keywords/people (e gênero quando vazio) do media_cache,
    // para o perfil ter tema e autor — não só gênero. Degrada sem cache.
    await enrichEventsFromCache(events, type);
    await enrichEventsFromCache(negativeEvents, type);

    const profile = taste.buildTasteProfile(events);
    const mood = taste.buildCurrentMood(events.slice(0, 20));
    const negative = taste.buildNegativeProfile(negativeEvents);
    const seeds = profile.topSeeds.map(seed => ({
      tmdbId: seed.tmdbId,
      title: seed.title,
      weight: seed.weight,
    }));

    // userVec NÃO é calculado aqui: as seeds finais só existem após
    // injectExternalSignals (ratings IMDb + cold_start_seeds). Calculado depois
    // da injeção, em buildForSession, para refletir o gosto completo.
    let acceptedVec = null;
    let rejectedVec = null;
    if (embeddings.hasProvider()) {
      acceptedVec = await embeddings.buildAcceptedVector(sessionId, type);
      rejectedVec = await embeddings.buildRejectedVector(sessionId, type);
    }

    contexts[type] = {
      events,
      negativeEvents,
      profile,
      mood,
      negative,
      seeds,
      topWatched: buildTopWatched(signals.watched[type], type, 15),
      userVec: null,
      acceptedVec,
      rejectedVec,
      hiddenIds: new Set(negativeEvents.map(event => event.tmdbId).filter(Boolean)),
    };
  }
  return contexts;
}

// Fills metadata (vote_count/year/genres/genre_ids/language) of candidates
// vindos só do embedding (vote_count 0) a partir do media_cache JÁ existente.
// NÃO chama TMDB. Sem entrada no cache, o candidato fica como está.
async function enrichFromCacheForFilter(pool, type) {
  const needIds = [];
  for (const candidate of pool) {
    const isEmbedding = (candidate.sources || []).some(source => source.kind === 'embedding');
    if (isEmbedding || !candidate.vote_count) needIds.push(candidate.tmdb_id);
  }
  if (!needIds.length) return pool;

  const cacheMap = await mediaCache.readCachedMedia(type, needIds).catch(() => new Map());
  if (!cacheMap.size) return pool;

  for (const candidate of pool) {
    const payload = cacheMap.get(Number(candidate.tmdb_id));
    if (!payload) continue;
    if (!candidate.vote_count && payload.vote_count) candidate.vote_count = payload.vote_count;
    if (!candidate.year && payload.year) candidate.year = Number(payload.year) || candidate.year;
    if (!candidate.original_language && payload.original_language) candidate.original_language = payload.original_language;
    if (!candidate.vote_average && payload.vote_average) candidate.vote_average = payload.vote_average;
    if ((!candidate.genres || !candidate.genres.length) && payload.genres?.length) {
      candidate.genres = payload.genres;
    }
    if (!candidate.genre_ids || !candidate.genre_ids.length) {
      const genreIds = taste.normalizeGenreIds(payload.genres || []);
      if (genreIds.length) candidate.genre_ids = genreIds;
    }
    // Tema/autor para keywordFit/peopleFit no score (e para o prompt do GLM).
    if ((!candidate.keywords || !candidate.keywords.length) && payload.keywords?.length) {
      candidate.keywords = payload.keywords;
    }
    if ((!candidate.people || !candidate.people.length)) {
      const directors = (payload.directors || []).map(p => p.name || p).filter(Boolean);
      const cast = (payload.cast || []).slice(0, 5).map(p => p.name || p).filter(Boolean);
      if (directors.length || cast.length) candidate.people = [...directors, ...cast];
    }
  }
  return pool;
}

// Ensures seed vectors exist in cache and returns the user's average vector.
// This side effect enables cross-type embedding because every final seed gets
// a vector in media_embeddings before the opposite media type searches it.
// Injectable deps ({ embeddings, mediaCache, tmdb }) keep tests network/db-free.
// Graceful no-op when no embedding provider is configured.
async function buildUserVectorForSeeds(type, seeds, deps = {}) {
  const emb = deps.embeddings || embeddings;
  const mc = deps.mediaCache || mediaCache;
  const tmdbApi = deps.tmdb || tmdb;
  if (!emb.hasProvider() || !seeds.length) return null;
  try {
    for (const seed of seeds) {
      if (!seed.tmdbId) continue;
      const media = await mc.loadCandidateMedia(
        { tmdb_id: seed.tmdbId, title: seed.title },
        type,
        { tmdb: tmdbApi },
      );
      await emb.ensureVec(type, { ...media, tmdb_id: seed.tmdbId, title: seed.title });
    }
    return await emb.buildUserVector(type, seeds);
  } catch (err) {
    console.warn(`[builder] userVec ${type} falhou:`, err.message);
    return null;
  }
}

// PURA: maior timestamp (unix s) de atividade COMPORTAMENTAL (watched + paused) de
// movies/episodes no payload de /sync/last_activities. 0 se indeterminável.
function latestBehaviorActivity(lastActivities) {
  if (!lastActivities) return 0;
  const fields = [
    lastActivities.movies && lastActivities.movies.watched_at,
    lastActivities.movies && lastActivities.movies.paused_at,
    lastActivities.episodes && lastActivities.episodes.watched_at,
    lastActivities.episodes && lastActivities.episodes.paused_at,
  ];
  let max = 0;
  for (const field of fields) {
    if (!field) continue;
    const ms = Date.parse(field);
    if (ms) max = Math.max(max, Math.floor(ms / 1000));
  }
  return max;
}

// PURA: decide se a sessão precisa de rebuild no cron diário. Sempre rebuilda em
// force, no primeiro build (sem lastBuildAt) ou quando a atividade é indeterminável
// (fail-open: melhor re-gerar sobre o cache do que parar de atualizar). Pula só
// quando há lastBuildAt e nada novo (watched/paused) desde então.
function needsRebuild({ force = false, lastBuildAt = 0, lastActivities = null } = {}) {
  if (force) return true;
  if (!lastBuildAt) return true;
  const latest = latestBehaviorActivity(lastActivities);
  if (!latest) return true;
  return latest > lastBuildAt;
}

async function buildForSession(sessionId, options = {}) {
  let locked = false;
  try {
    locked = await acquireLock(sessionId);
    if (!locked) return;
  } catch (err) {
    console.error(`[builder] lock error ${sessionId}:`, err.message);
    return;
  }

  const runId = crypto.randomUUID().slice(0, 12);
  await db.execute({
    sql: 'INSERT INTO builder_runs (id, session_id, status, started_at) VALUES (?, ?, ?, ?)',
    args: [runId, sessionId, 'running', Math.floor(Date.now() / 1000)],
  });

  let totalRecs = 0;

  try {
    const session = await sessions.load(sessionId);
    if (!session || session.status === 'needs_reauth') throw new Error('session_invalid');

    let accessToken = session.access_token;
    if (sessions.isExpired(session)) {
      console.log(`[builder] ${sessionId}: renovando token Trakt...`);
      let fresh;
      try {
        fresh = await trakt.refreshAccessToken(session.refresh_token);
        if (!fresh?.access_token) throw new Error('refresh_failed');
      } catch {
        await db.execute({
          sql: "UPDATE sessions SET status='needs_reauth', last_build_error='token_expired' WHERE id=?",
          args: [sessionId],
        });
        throw new Error('refresh_failed');
      }
      await sessions.update(sessionId, fresh);
      accessToken = fresh.access_token;
    }

    // Skip diário: se nada foi assistido/pausado desde o último build, não re-gera
    // (economiza GLM/TMDB/embedding, alivia o Trakt e não embaralha a lista de quem
    // não fez nada). options.force ignora o skip (rebuild manual/pós-deploy).
    if (!options.force) {
      const lastActivities = await trakt.getLastActivities(accessToken).catch(() => null);
      if (!needsRebuild({ lastBuildAt: session.last_build_at, lastActivities })) {
        console.log(`[builder] ${sessionId}: sem atividade nova desde o último build — pulando`);
        await db.execute({
          sql: "UPDATE builder_runs SET status='skipped', finished_at=? WHERE id=?",
          args: [Math.floor(Date.now() / 1000), runId],
        }).catch(() => {});
        return;
      }
    }

    const signals = await loadSignals(sessionId, accessToken);
    const typeContexts = await buildTypeContexts(sessionId, signals);

    // Feature 1 & 2: injeta user_ratings e cold_start_seeds nos contextos por tipo
    for (const type of ['movie', 'series']) {
      await injectExternalSignals(sessionId, typeContexts[type], type);
    }

    // userVec is calculated after external signals so it reflects behavioral signals,
    // IMDb ratings, and cold-start seeds. Ensuring vectors for every final seed is what
    // enables cross-type embedding between movie and series recommendations.
    for (const type of ['movie', 'series']) {
      typeContexts[type].userVec = await buildUserVectorForSeeds(type, typeContexts[type].seeds);
    }

    for (const type of ['movie', 'series']) {
      const hard = await feedback.loadHardExcludedIds(sessionId, type);
      if (hard.size) {
        const ctx = typeContexts[type];
        ctx.hiddenIds = new Set([...(ctx.hiddenIds || []), ...hard]);
      }
    }

    for (const cat of catalogsForBuild(options)) {
      const { id: catalogId, type } = cat;
      const debug = emptyDebug();
      try {
        const { profile, mood, negative, seeds, topWatched, hiddenIds, userVec, acceptedVec, rejectedVec, coldSeedIds } = typeContexts[type];
        debug.seeds = seeds.length;

        // Sem seeds: discover ainda corre (popularidade); cold start trending preenche abaixo

        const shownIds = await getShownIds(sessionId, type);
        console.log(`[builder] ${sessionId} ${catalogId}/${type}: ${seeds.length} seeds, gerando candidatos...`);
        let pool = await candidatesMod.buildCandidates(
          { profile, mood, seeds, type, catalogId, userVec, topWatched },
          { tmdb, callAI: simpleCallAI, trakt },
        );

        // Cold start enrichment: quando o usuário tem poucas sementes do tipo atual,
        // usa cold_start_seeds do tipo oposto para gerar candidatos via AI e embeddings.
        if (seeds.length < 3) {
          const otherType = type === 'movie' ? 'series' : 'movie';
          const otherCtx = typeContexts[otherType];
          const otherColdSeeds = otherCtx && otherCtx.coldSeeds;

          // Addition B: Cross-type AI essence — AI gera títulos do tipo atual com a alma do tipo oposto
          if (otherColdSeeds && otherColdSeeds.length > 0) {
            try {
              const crossEssence = await candidatesMod.crossTypeEssenceCandidates(
                { otherTypeProfile: otherCtx.profile, otherTypeSeeds: otherColdSeeds, targetType: type },
                { tmdb, callAI: simpleCallAI },
              );
              if (crossEssence.length) {
                pool = candidatesMod.mergeCandidates(pool, crossEssence);
                debug.cross_essence = crossEssence.length;
              }
            } catch (err) {
              console.warn(`[builder] cross-essence ${type} falhou:`, err.message);
            }
          }

          // Addition C: Cross-type embedding kNN — userVec do tipo oposto busca candidatos no tipo atual
          if (otherColdSeeds && otherColdSeeds.length > 0) {
            try {
              const crossVec = await embeddings.buildUserVector(otherType, otherColdSeeds);
              if (crossVec) {
                const crossEmb = await candidatesMod.embeddingCandidates({ userVec: crossVec, type }, { db });
                if (crossEmb.length) {
                  const relabeled = crossEmb.map(c => ({
                    ...c,
                    sources: [{ kind: 'cross_embedding', seed: 'cross_type' }],
                  }));
                  pool = candidatesMod.mergeCandidates(pool, relabeled);
                  debug.cross_embedding = relabeled.length;
                }
              }
            } catch (err) {
              console.warn(`[builder] cross-embedding ${type} falhou:`, err.message);
            }
          }
        }

        // Feature 1: cold start — preenche pool com trending quando sementes ou pool são escassos
        if (seeds.length < 3 || pool.length < MIN) {
          const trending = await candidatesMod.coldStartCandidates({ type }, { tmdb }).catch(() => []);
          if (trending.length) {
            pool = candidatesMod.mergeCandidates(pool, trending);
            debug.cold_start_trending = trending.length;
          }
        }

        debug.candidates_raw = pool.length;
        countSources(debug, pool);
        console.log(`[builder] ${sessionId} ${catalogId}/${type}: ${pool.length} candidatos brutos`);

        // Vizinhos de alma puros entram só via embedding (vote_count 0): preenche
        // metadados do cache antes do filtro para o piso por-fonte poder avaliá-los.
        await enrichFromCacheForFilter(pool, type);

        const minVotes = catalogId === 'new-for-you' ? 20 : (catalogId === 'watch-next' ? 300 : 120);
        const nowYear = new Date().getFullYear();
        const minYear = catalogId === 'new-for-you' ? nowYear - NEW_FOR_YOU_MAX_AGE_YEARS : 0;
        const filtered = chooseFilteredCandidates(pool, {
          watchedSet: signals.watchedSets[type],
          shownIds,
          hiddenIds,
          coldSeedIds: coldSeedIds || new Set(),
          minVotes,
          minVotesEmbedding: 30,
          minYear,
          minNeeded: Math.min(CURATION_INPUT, MIN * 2),
          debug,
        });
        debug.candidates_filtered = filtered.length;

        if (filtered.length < 5) {
          await recordDebug(sessionId, catalogId, type, debug);
          continue;
        }

        const memoryMap = await memory.loadRecommendationMemory(sessionId, type);

        // Anexa vetores cacheados aos candidatos filtrados (batch). Sem vetor → fits 0.
        // Vale para userVec, acceptedVec e rejectedVec (e habilita o MMR por _vec).
        if (userVec || acceptedVec || rejectedVec) {
          const vecMap = await embeddings.getCachedVecs(type, filtered.map(c => c.tmdb_id));
          for (const candidate of filtered) {
            const vec = vecMap.get(Number(candidate.tmdb_id));
            if (vec) candidate._vec = vec;
          }
        }

        const rankedRaw = score.rankAndDiversify(
          filtered,
          { profile, mood, negative, catalogId, userVec, acceptedVec, rejectedVec },
          { target: 60 },
        );
        const ranked = memory.applyRecommendationMemory(rankedRaw, memoryMap)
          .sort((a, b) => (b._score || 0) - (a._score || 0))
          .slice(0, CURATION_INPUT);
        debug.scored = ranked.length;
        console.log(`[builder] ${sessionId} ${catalogId}/${type}: ${ranked.length} ranqueados, enriquecendo prompt e curando...`);
        const enrichedRanked = await mediaCache.enrichCandidates(ranked, type, { tmdb });

        // Cache de embeddings cresce a cada build (desacoplado do mediaCache).
        if (embeddings.hasProvider()) {
          for (const item of enrichedRanked) {
            try {
              await embeddings.ensureVec(type, item);
            } catch {
              // falha de cache não pode quebrar o build
            }
          }
        }

        const curated = await curator.curate(enrichedRanked, { profile, type, catalogId }, curatorCallAI);
        debug.curated = curated.length;
        debug.ai_failed = didCuratorFail(catalogId, curated);

        // Backfill honesto a partir do enrichedRanked (tem imdb_id/metadados).
        const refs = finalOrder(curated, enrichedRanked, { target: TARGET });
        debug.backfilled = refs.filter(ref => ref._backfill).length;
        if (refs.length < MIN) {
          console.log(`[builder] ${sessionId} ${catalogId}/${type}: nem o determinístico encheu (${refs.length}), mantendo catálogo anterior`);
          await recordDebug(sessionId, catalogId, type, debug);
          continue;
        }
        console.log(`[builder] ${sessionId} ${catalogId}/${type}: enriquecendo ${Math.min(refs.length, TARGET)} itens...`);
        const items = await enrichItems(refs, type);
        debug.saved = items.length;

        if (items.length < MIN) {
          console.log(`[builder] ${sessionId} ${catalogId}/${type}: abaixo do mínimo (${items.length}), mantendo catálogo anterior`);
          await recordDebug(sessionId, catalogId, type, debug);
          continue;
        }

        const builtAt = await saveCatalog(sessionId, catalogId, type, items);
        await memory.recordRecommendations(sessionId, catalogId, type, refs.slice(0, items.length), builtAt);
        await saveTasteProfile(sessionId, type, {
          confidence: profile.confidence,
          genres: profile.genres,
          languages: profile.languages,
          decades: profile.decades,
          topSeeds: profile.topSeeds,
        }, builtAt);

        totalRecs += items.length;
        console.log(`[builder] ${sessionId} ${catalogId}/${type}: ${items.length} recs (curadas ${debug.curated}, backfill ${debug.backfilled})`);
      } catch (err) {
        debug.error = err.stack || err.message;
        console.error(`[builder] ${sessionId} ${catalogId}/${type} error:`, err.stack || err.message);
      } finally {
        await recordDebug(sessionId, catalogId, type, debug);
      }
    }

    await db.execute({
      sql: 'UPDATE sessions SET last_build_at=?, last_build_error=NULL WHERE id=?',
      args: [Math.floor(Date.now() / 1000), sessionId],
    });
    await db.execute({
      sql: "UPDATE builder_runs SET status='success', finished_at=?, recs_generated=? WHERE id=?",
      args: [Math.floor(Date.now() / 1000), totalRecs, runId],
    });
    console.log(`[builder] ${sessionId}: concluído - ${totalRecs} recs totais`);
  } catch (err) {
    console.error(`[builder] ${sessionId} falha:`, err.message);
    await db.execute({
      sql: "UPDATE builder_runs SET status='failed', finished_at=?, error=? WHERE id=?",
      args: [Math.floor(Date.now() / 1000), err.message, runId],
    }).catch(() => {});
    await db.execute({
      sql: 'UPDATE sessions SET last_build_error=? WHERE id=?',
      args: [err.message, sessionId],
    }).catch(() => {});
  } finally {
    if (locked) {
      await db.execute({
        sql: 'DELETE FROM builder_locks WHERE session_id=?',
        args: [sessionId],
      }).catch(() => {});
    }
  }
}

async function buildAll() {
  await initSchema();
  const sessionIds = await sessions.listActive();
  console.log(`[builder] ${sessionIds.length} sessão(ões) ativas`);
  await runWithConcurrency(sessionIds, 2, async (id) => {
    try {
      await withTimeout(buildForSession(id), SESSION_BUILD_TIMEOUT_MS, `session:${id}`);
    } catch (err) {
      console.error(`[builder] sessão ${id} timeout/falha:`, err.message);
    }
  });
  console.log('[builder] todos os builds concluídos');
}

module.exports = {
  buildForSession,
  buildAll,
  buildWatchedSets,
  catalogsForBuild,
  catalogItemFromCandidate,
  finalOrder,
  didCuratorFail,
  filterCandidates,
  chooseFilteredCandidates,
  fetchTraktSignal,
  buildTopWatched,
  buildUserVectorForSeeds,
  latestBehaviorActivity,
  needsRebuild,
  withTimeout,
  runWithConcurrency,
  // Feature 1 & 2 — exportados para testes
  loadColdStartSeeds,
  loadUserRatingsForType,
  buildUserRatingEvents,
  injectExternalSignals,
};

if (require.main === module) {
  buildAll().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
