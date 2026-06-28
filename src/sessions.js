const { db } = require('./db');

async function save(tokenData, traktUserId) {
  const now = Math.floor(Date.now() / 1000);

  // Re-login: acha a MESMA pessoa pelo id do Trakt (coluna interna) e reaproveita
  // o id aleatório já existente — preserva memória SEM expor o id do Trakt na URL.
  if (traktUserId) {
    const existing = await db.execute({
      sql: 'SELECT id FROM sessions WHERE trakt_user_id = ?',
      args: [traktUserId],
    });
    if (existing.rows.length) {
      const id = existing.rows[0].id;
      await db.execute({
        sql: `UPDATE sessions SET access_token=?, refresh_token=?, expires_in=?, created_at=?, status='active'
              WHERE id=?`,
        args: [tokenData.access_token, tokenData.refresh_token, tokenData.expires_in, now, id],
      });
      return id;
    }
  }

  // Sessão nova: id ALEATÓRIO (segredo da URL, inadivinhável); trakt_user_id só pra reencontrar depois
  const id = require('crypto').randomUUID();
  await db.execute({
    sql: `INSERT INTO sessions (id, access_token, refresh_token, expires_in, created_at, status, trakt_user_id)
          VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    args: [id, tokenData.access_token, tokenData.refresh_token, tokenData.expires_in, now, traktUserId || null],
  });
  return id;
}

async function load(id) {
  if (!id) return null;
  const res = await db.execute({
    sql: 'SELECT * FROM sessions WHERE id = ?',
    args: [id],
  });
  if (!res.rows.length) return null;
  const row = res.rows[0];
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_in: row.expires_in,
    created_at: row.created_at,
    status: row.status,
    last_build_at: row.last_build_at,
  };
}

async function update(id, tokenData) {
  await db.execute({
    sql: `UPDATE sessions SET access_token=?, refresh_token=?, expires_in=?, created_at=?, status='active'
          WHERE id=?`,
    args: [tokenData.access_token, tokenData.refresh_token,
           tokenData.expires_in, Math.floor(Date.now() / 1000), id],
  });
}

async function listActive() {
  const res = await db.execute("SELECT id FROM sessions WHERE status = 'active'");
  return res.rows.map(r => r.id);
}

// Buffer de 1 hora antes de expirar
function isExpired(session) {
  return Math.floor(Date.now() / 1000) >= session.created_at + session.expires_in - 3600;
}

module.exports = { save, load, update, listActive, isExpired };
