const { db: defaultDb } = require('./db');

const MAX_AGE_SECONDS = 30 * 86400;

function isFresh(row, now = Math.floor(Date.now() / 1000)) {
  return row?.updated_at && now - Number(row.updated_at) < MAX_AGE_SECONDS;
}

function normalizeMediaPayload(candidate, details = {}, credits = {}, keywords = []) {
  return {
    tmdb_id: candidate.tmdb_id,
    imdb_id: details.imdb_id || candidate.imdb_id || null,
    title: details.title || candidate.title || '',
    year: details.year || candidate.year || 0,
    poster: details.poster || candidate.poster || null,
    backdrop: details.backdrop || candidate.backdrop || null,
    vote_average: details.vote_average || candidate.vote_average || 0,
    vote_count: details.vote_count || candidate.vote_count || 0,
    genres: details.genres || candidate.genres || [],
    runtime: details.runtime || candidate.runtime || null,
    overview: details.overview || candidate.overview || '',
    original_language: details.original_language || candidate.original_language || '',
    origin_country: details.origin_country || candidate.origin_country || [],
    directors: credits.directors || [],
    cast: credits.cast || [],
    keywords: keywords || [],
  };
}

async function upsertFts(db, type, tmdbId, payload) {
  const kw = (payload.keywords || []).map(k => k.name || k).filter(Boolean).join(' ');
  const text = [payload.title, payload.overview, kw].filter(Boolean).join(' ').trim();
  if (!text) return;
  try {
    await db.execute({ sql: 'DELETE FROM media_fts WHERE tmdb_id=? AND type=?', args: [Number(tmdbId), type] });
    await db.execute({ sql: 'INSERT INTO media_fts (tmdb_id, type, text) VALUES (?, ?, ?)', args: [Number(tmdbId), type, text] });
  } catch {
    // FTS5 may be unavailable in some libSQL builds.
  }
}

async function loadCandidateMedia(candidate, type, deps = {}) {
  const db = deps.db || defaultDb;
  const tmdb = deps.tmdb;
  if (!candidate?.tmdb_id) return {};

  const cached = await db.execute({
    sql: 'SELECT payload, updated_at FROM media_cache WHERE type=? AND tmdb_id=?',
    args: [type, candidate.tmdb_id],
  }).catch(() => ({ rows: [] }));
  const row = cached.rows?.[0];
  if (row && isFresh(row)) {
    try {
      return JSON.parse(row.payload || '{}');
    } catch {
      // refresh corrupt cache below
    }
  }

  if (!tmdb) return {};
  // Uma única chamada TMDB (append_to_response) traz details+credits+keywords.
  const { details, credits, keywords } = await tmdb
    .getFullMedia(candidate.tmdb_id, type)
    .catch(() => ({ details: null, credits: {}, keywords: [] }));
  if (!details) return {};

  const payload = normalizeMediaPayload(candidate, details, credits, keywords);
  await db.execute({
    sql: `INSERT INTO media_cache (type, tmdb_id, payload, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(type, tmdb_id)
          DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
    args: [type, candidate.tmdb_id, JSON.stringify(payload), Math.floor(Date.now() / 1000)],
  }).catch(() => {});
  await upsertFts(db, type, candidate.tmdb_id, payload);
  return payload;
}

// Leitura em batch do media_cache (apenas cache, sem TMDB). Map(tmdb_id -> payload).
// Respeita o frescor (MAX_AGE_SECONDS) e ignora payloads corrompidos.
async function readCachedMedia(type, tmdbIds = [], deps = {}) {
  const db = deps.db || defaultDb;
  const out = new Map();
  const ids = Array.from(new Set((tmdbIds || []).map(Number).filter(Boolean)));
  if (!ids.length) return out;

  const placeholders = ids.map(() => '?').join(',');
  const res = await db.execute({
    sql: `SELECT tmdb_id, payload, updated_at FROM media_cache WHERE type=? AND tmdb_id IN (${placeholders})`,
    args: [type, ...ids],
  }).catch(() => ({ rows: [] }));

  for (const row of res.rows || []) {
    if (!isFresh(row)) continue;
    try {
      out.set(Number(row.tmdb_id), JSON.parse(row.payload || '{}'));
    } catch {
      // ignora linha corrompida
    }
  }
  return out;
}

async function enrichCandidates(candidates, type, deps = {}) {
  const input = candidates || [];
  const out = new Array(input.length);
  const limit = Math.max(1, Math.min(Number(deps.concurrency) || 4, input.length || 1));
  let next = 0;

  async function worker() {
    while (next < input.length) {
      const index = next++;
      const candidate = input[index];
      const media = await loadCandidateMedia(candidate, type, deps);
      out[index] = { ...candidate, ...media };
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}

module.exports = {
  MAX_AGE_SECONDS,
  isFresh,
  normalizeMediaPayload,
  loadCandidateMedia,
  readCachedMedia,
  enrichCandidates,
  upsertFts,
};
