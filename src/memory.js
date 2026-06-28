const { db } = require('./db');

function serializeSources(sources) {
  return JSON.stringify(sources || []);
}

function recommendationMemoryPenalty(row) {
  if (!row || row.accepted_at) return 0;
  const times = Number(row.times_recommended || 0);
  return Math.min(0.35, Math.max(0, times - 1) * 0.08);
}

function eventRows(sessionId, type, eventType, events) {
  return (events || [])
    .filter(event => event.tmdbId)
    .map(event => ({
      session_id: sessionId,
      type,
      event_type: eventType,
      tmdb_id: event.tmdbId,
      title: event.title || '',
      occurred_at: Math.floor((event.occurredAt || Date.now()) / 1000),
      weight: event.weight || 0,
      raw_json: JSON.stringify(event),
    }));
}

async function recordUserEvents(sessionId, type, eventType, events) {
  const limit = eventType === 'negative_signal' ? 80 : 160;
  const selected = [...(events || [])]
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, limit);
  const rows = eventRows(sessionId, type, eventType, selected);
  const statements = rows.map(row => ({
    sql: `INSERT OR IGNORE INTO user_events
          (session_id, type, event_type, tmdb_id, title, occurred_at, weight, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.session_id,
      row.type,
      row.event_type,
      row.tmdb_id,
      row.title,
      row.occurred_at,
      row.weight,
      row.raw_json,
    ],
  }));

  if (typeof db.batch === 'function' && statements.length) {
    await db.batch(statements, 'write');
    return;
  }

  for (const statement of statements) {
    await db.execute({
      sql: statement.sql,
      args: statement.args,
    });
  }
}

async function loadRecommendationMemory(sessionId, type) {
  const res = await db.execute({
    sql: 'SELECT tmdb_id, times_recommended, accepted_at FROM recommendation_memory WHERE session_id=? AND type=?',
    args: [sessionId, type],
  });
  const map = new Map();
  for (const row of res.rows) map.set(Number(row.tmdb_id), row);
  return map;
}

function applyRecommendationMemory(candidates, memoryMap) {
  return (candidates || []).map(candidate => {
    const row = memoryMap?.get(Number(candidate.tmdb_id));
    const penalty = recommendationMemoryPenalty(row);
    return penalty ? { ...candidate, _memory_penalty: penalty, _score: (candidate._score || 0) - penalty } : candidate;
  });
}

async function markAcceptedFromWatched(sessionId, type, watchedSet) {
  if (!watchedSet?.size) return;
  const pending = await db.execute({
    sql: 'SELECT tmdb_id FROM recommendation_memory WHERE session_id=? AND type=? AND accepted_at IS NULL',
    args: [sessionId, type],
  });
  const toAccept = pending.rows
    .map(row => Number(row.tmdb_id))
    .filter(tmdbId => watchedSet.has(tmdbId));
  if (!toAccept.length) return;

  const now = Math.floor(Date.now() / 1000);
  const statements = toAccept.map(tmdbId => ({
    sql: `UPDATE recommendation_memory
          SET accepted_at=COALESCE(accepted_at, ?)
          WHERE session_id=? AND type=? AND tmdb_id=? AND accepted_at IS NULL`,
    args: [now, sessionId, type, tmdbId],
  }));

  if (typeof db.batch === 'function') {
    await db.batch(statements, 'write');
    return;
  }

  for (const statement of statements) {
    await db.execute({
      sql: statement.sql,
      args: statement.args,
    });
  }
}

async function recordRecommendations(sessionId, catalogId, type, refs, builtAt) {
  for (const ref of refs || []) {
    const candidate = ref.candidate || ref;
    if (!candidate?.tmdb_id) continue;
    await db.execute({
      sql: `INSERT INTO recommendation_memory
            (session_id, type, tmdb_id, first_recommended_at, last_recommended_at, times_recommended, last_catalog_id, sources_json)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(session_id, type, tmdb_id)
            DO UPDATE SET
              last_recommended_at=excluded.last_recommended_at,
              times_recommended=times_recommended + 1,
              last_catalog_id=excluded.last_catalog_id,
              sources_json=excluded.sources_json`,
      args: [
        sessionId,
        type,
        candidate.tmdb_id,
        builtAt,
        builtAt,
        catalogId,
        serializeSources(candidate.sources),
      ],
    });
  }
}

module.exports = {
  serializeSources,
  recommendationMemoryPenalty,
  eventRows,
  recordUserEvents,
  loadRecommendationMemory,
  applyRecommendationMemory,
  markAcceptedFromWatched,
  recordRecommendations,
};
