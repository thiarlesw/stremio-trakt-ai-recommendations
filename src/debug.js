const { db } = require('./db');

function serializeDebugPayload(payload) {
  return JSON.stringify(payload || {});
}

async function recordDebug(sessionId, catalogId, type, payload) {
  try {
    await db.execute({
      sql: `INSERT INTO build_debug (session_id, catalog_id, type, built_at, payload)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id, catalog_id, type)
            DO UPDATE SET built_at=excluded.built_at, payload=excluded.payload`,
      args: [
        sessionId,
        catalogId,
        type,
        Math.floor(Date.now() / 1000),
        serializeDebugPayload(payload),
      ],
    });
  } catch (err) {
    console.error(`[debug] falha ao gravar ${catalogId}/${type}:`, err.message);
  }
}

module.exports = { recordDebug, serializeDebugPayload };
