'use strict';

require('dotenv').config();
const { db, initSchema } = require('../src/db');
const tmdb = require('../src/tmdb');

const [, , sessionId, type, title, yearStr] = process.argv;
const year = yearStr ? parseInt(yearStr, 10) : undefined;

if (!sessionId || !type || !title) {
  console.error('Uso: node scripts/add-coldstart-seed.js <sessionId> <movie|series> "<titulo>" [ano]');
  process.exit(1);
}

if (!['movie', 'series'].includes(type)) {
  console.error('type deve ser movie ou series');
  process.exit(1);
}

(async () => {
  await initSchema();

  const results = await tmdb.searchTitle(title, year, type);
  const match = tmdb.pickBestMatch(results, { title, year, type });

  if (!match) {
    console.error(`Nao encontrado no TMDB: "${title}"`);
    process.exit(1);
  }

  const tmdbId = match.id;
  const resolvedTitle = match.title || match.name || title;
  const weight = 5;
  const addedAt = Math.floor(Date.now() / 1000);

  await db.execute({
    sql: `INSERT INTO cold_start_seeds (session_id, tmdb_id, type, weight, title, added_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, tmdb_id, type)
          DO UPDATE SET weight=excluded.weight, title=excluded.title, added_at=excluded.added_at`,
    args: [sessionId, tmdbId, type, weight, resolvedTitle, addedAt],
  });

  console.log(`Seed adicionada: "${resolvedTitle}" (tmdb_id=${tmdbId}, type=${type}, weight=${weight})`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
