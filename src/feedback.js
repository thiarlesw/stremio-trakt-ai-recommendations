'use strict';

const VALID_FEEDBACK = new Set(['less_like_this', 'already_seen', 'hide', 'too_obvious', 'too_weird']);
const HARD_EXCLUDE = new Set(['hide', 'already_seen']);

function lazyDb(deps) {
  return (deps && deps.db) || require('./db').db;
}

async function recordFeedback(sessionId, type, tmdbId, feedback, deps = {}) {
  const id = Number(tmdbId);
  if (!sessionId || (type !== 'movie' && type !== 'series') || !id || !VALID_FEEDBACK.has(feedback)) {
    return { ok: false, error: 'invalid' };
  }
  const db = lazyDb(deps);
  await db.execute({
    sql: `INSERT INTO recommendation_feedback (session_id, type, tmdb_id, feedback, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, type, tmdb_id, feedback) DO NOTHING`,
    args: [sessionId, type, id, feedback, Math.floor(Date.now() / 1000)],
  });
  return { ok: true };
}

async function loadHardExcludedIds(sessionId, type, deps = {}) {
  const db = lazyDb(deps);
  try {
    const res = await db.execute({
      sql: "SELECT tmdb_id FROM recommendation_feedback WHERE session_id=? AND type=? AND feedback IN ('hide','already_seen')",
      args: [sessionId, type],
    });
    return new Set((res.rows || []).map(row => Number(row.tmdb_id)).filter(Boolean));
  } catch {
    return new Set();
  }
}

module.exports = { recordFeedback, loadHardExcludedIds, VALID_FEEDBACK, HARD_EXCLUDE };
