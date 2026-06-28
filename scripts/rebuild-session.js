'use strict';

// Rebuild FORÇADO de uma sessão (ou de todas as ativas), furando o skip diário.
// Uso: node scripts/rebuild-session.js [sessionId]
//   - com sessionId: rebuilda só aquela sessão
//   - sem argumento: rebuilda todas as ativas (com force)
// Imprime o resumo de build_debug por catálogo ao final.

require('dotenv').config();
const { initSchema, db } = require('../src/db');
const sessions = require('../src/sessions');
const { buildForSession } = require('../src/builder');

const [, , sessionId] = process.argv;

(async () => {
  await initSchema();
  const ids = sessionId ? [sessionId] : await sessions.listActive();
  if (!ids.length) {
    console.log('Sem sessões para rebuildar.');
    return;
  }

  for (const id of ids) {
    console.log(`\n=== rebuild forçado: ${id} ===`);
    await buildForSession(id, { force: true });
    const debug = await db.execute({
      sql: 'SELECT catalog_id, type, payload FROM build_debug WHERE session_id=? ORDER BY catalog_id, type',
      args: [id],
    });
    for (const row of debug.rows) {
      console.log(row.catalog_id, row.type, row.payload);
    }
  }
  console.log('\n[rebuild] concluído');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
