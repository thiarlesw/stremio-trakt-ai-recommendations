'use strict';

require('dotenv').config();
const { db, initSchema } = require('../src/db');
const { importFromCsv } = require('../src/imdbRatings');
const tmdb = require('../src/tmdb');

const [, , sessionId, csvPath] = process.argv;

if (!sessionId || !csvPath) {
  console.error('Uso: node scripts/import-imdb.js <sessionId> <csvPath>');
  process.exit(1);
}

(async () => {
  await initSchema();
  const count = await importFromCsv(sessionId, csvPath, { db, tmdb });
  console.log(`Importadas ${count} notas IMDb para sessao ${sessionId}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
