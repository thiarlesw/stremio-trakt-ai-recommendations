const { db } = require('./db');

async function getCatalog(type, catalogId, sessionId) {
  if (!sessionId) return [];

  let res;
  try {
    res = await db.execute({
      sql: `SELECT items, built_at FROM recommendations
            WHERE session_id=? AND catalog_id=? AND type=?
            ORDER BY built_at DESC LIMIT 1`,
      args: [sessionId, catalogId, type],
    });
  } catch (err) {
    console.error(`[catalog] db error ${catalogId}/${type}:`, err.message);
    return [];
  }

  if (!res.rows.length) return [];

  const row = res.rows[0];
  const staleHours = (Math.floor(Date.now() / 1000) - row.built_at) / 3600;
  if (staleHours > 72) {
    console.warn(`[stale] ${sessionId} ${catalogId}/${type}: ${staleHours.toFixed(0)}h sem build`);
  }

  let items;
  try {
    items = JSON.parse(row.items);
  } catch {
    return [];
  }

  return items
    .filter(item => item.imdb_id)
    .map(item => ({
      id: item.imdb_id,
      type,
      name: item.title,
      poster: item.poster || undefined,
      background: item.backdrop || undefined,
      description: item.why || undefined,
      releaseInfo: item.year ? String(item.year) : undefined,
      imdbRating: item.vote_average ? String(item.vote_average) : undefined,
      genres: item.genres || [],
    }));
}

module.exports = { getCatalog };
