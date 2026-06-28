require('dotenv').config();
const { initSchema, db } = require('../src/db');
const sessions = require('../src/sessions');
const { buildForSession } = require('../src/builder');

(async () => {
  await initSchema();
  const ids = await sessions.listActive();
  if (!ids.length) {
    console.log('Sem sessões ativas. Conecte um Trakt primeiro.');
    return;
  }

  const sessionId = ids[0];
  const [catalog, type] = (process.env.SMOKE_CATALOG || '').split(':');
  const options = catalog && type ? { catalog, type } : {};
  await buildForSession(sessionId, options);
  const debug = await db.execute({
    sql: 'SELECT catalog_id, type, payload FROM build_debug WHERE session_id=? ORDER BY catalog_id, type',
    args: [sessionId],
  });
  for (const row of debug.rows) {
    console.log(row.catalog_id, row.type, row.payload);
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
