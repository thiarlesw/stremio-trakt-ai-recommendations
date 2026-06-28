'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCsv, importFromCsv } = require('../src/imdbRatings');

// Fixture extraida do arquivo real de exportacao do IMDb.
// Inclui: 1 Movie, 1 TV Series, 1 TV Episode (deve ser ignorado), 1 TV Mini Series, 1 Movie adicional.
// Tambem testa campos com virgulas internas dentro de aspas (Genres, Directors).
const CSV_FIXTURE = `Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
tt12042730,10,2026-06-19,"Project Hail Mary","Project Hail Mary",https://www.imdb.com/title/tt12042730,Movie,8.2,156,2026,"Sci-Fi, Adventure, Comedy, Drama",372914,"2026-03-20","Phil Lord,Christopher Miller"
tt32140872,4,2026-06-08,"Star City","Star City",https://www.imdb.com/title/tt32140872,TV Series,7.1,,2026,"Drama, Sci-Fi",2434,"2026-05-29",
tt38499319,10,2025-11-30,"Heated Rivalry: Rookies","Heated Rivalry: Rookies",https://www.imdb.com/title/tt38499319,TV Episode,9.0,50,2025,"Drama, Sport, Romance",38996,"2025-11-28","Jacob Tierney"
tt34888633,3,2025-10-16,"Red Alert","Red Alert",https://www.imdb.com/title/tt34888633,TV Mini Series,6.9,,2025,"Drama, History",3774,"2025-10-07",
tt0816711,9,2026-04-02,"World War Z","World War Z",https://www.imdb.com/title/tt0816711,Movie,7.0,116,2013,"Action, Adventure, Horror, Sci-Fi",786624,"2013-06-21","Marc Forster"`;

test('parseCsv: retorna apenas movie e series, ignora TV Episode', () => {
  const entries = parseCsv(CSV_FIXTURE);

  assert.equal(entries.length, 4, 'Movie x2 + TV Series x1 + TV Mini Series x1; TV Episode ignorado');
  assert.ok(entries.every(e => e.type === 'movie' || e.type === 'series'));
  assert.equal(entries.filter(e => e.type === 'movie').length, 2);
  assert.equal(entries.filter(e => e.type === 'series').length, 2);
});

test('parseCsv: extrai imdbId, rating, title, year e type corretamente', () => {
  const entries = parseCsv(CSV_FIXTURE);

  const movie = entries.find(e => e.imdbId === 'tt12042730');
  assert.ok(movie, 'deve encontrar Project Hail Mary');
  assert.equal(movie.rating, 10);
  assert.equal(movie.title, 'Project Hail Mary');
  assert.equal(movie.year, 2026);
  assert.equal(movie.type, 'movie');

  const series = entries.find(e => e.imdbId === 'tt32140872');
  assert.ok(series, 'deve encontrar Star City');
  assert.equal(series.rating, 4);
  assert.equal(series.type, 'series');

  const miniSeries = entries.find(e => e.imdbId === 'tt34888633');
  assert.ok(miniSeries, 'deve encontrar Red Alert (TV Mini Series)');
  assert.equal(miniSeries.type, 'series');
  assert.equal(miniSeries.rating, 3);
});

test('parseCsv: lida com virgulas dentro de campos entre aspas (Directors, Genres)', () => {
  // "Phil Lord,Christopher Miller" no campo Directors nao deve quebrar o parser.
  // Se o parser falhar, o Title Type seria parseado errado e o movie seria ignorado ou tipado errado.
  const entries = parseCsv(CSV_FIXTURE);

  const movie = entries.find(e => e.imdbId === 'tt12042730');
  assert.ok(movie, 'filme com directors multi deve ser encontrado');
  assert.equal(movie.type, 'movie', 'tipo nao deve ser corrompido por virgula no Directors');
});

test('parseCsv: TV Episode (campo 6 = "TV Episode") e ignorado', () => {
  const entries = parseCsv(CSV_FIXTURE);

  const episode = entries.find(e => e.imdbId === 'tt38499319');
  assert.equal(episode, undefined, 'TV Episode deve ser filtrado');
});

test('parseCsv: texto vazio retorna array vazio', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('Const,Rating\n'), []);
});

test('parseCsv: imdbIds sem prefixo "tt" sao ignorados', () => {
  const badCsv = `Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
nm1234567,8,2024-01-01,"Pessoa","Pessoa",https://x.com,Movie,7,90,2020,"Drama",1000,"2020-01-01","Dir"`;
  assert.deepEqual(parseCsv(badCsv), []);
});

test('importFromCsv: faz upsert no banco para entradas validas', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-imdb-${Date.now()}.csv`);
  fs.writeFileSync(tmpFile, CSV_FIXTURE, 'utf8');

  const writes = [];
  const fakeDb = {
    execute: async ({ sql, args }) => {
      if (/INSERT.*user_ratings/i.test(sql)) writes.push(args);
      return { rows: [] };
    },
  };

  let count;
  try {
    count = await importFromCsv('sess-test', tmpFile, { db: fakeDb });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  assert.equal(count, 4, 'deve retornar 4 (Movie x2 + TV Series + TV Mini Series)');
  assert.equal(writes.length, 4, 'deve fazer 4 upserts no banco');
  // Cada upsert deve ter session_id como primeiro arg
  assert.ok(writes.every(args => args[0] === 'sess-test'));
});

test('importFromCsv: sem deps.tmdb, tmdb_id fica null mas count e correto', async () => {
  const tmpFile = path.join(os.tmpdir(), `test-imdb-notmdb-${Date.now()}.csv`);
  fs.writeFileSync(tmpFile, CSV_FIXTURE, 'utf8');

  const writes = [];
  const fakeDb = {
    execute: async ({ sql, args }) => {
      if (/INSERT.*user_ratings/i.test(sql)) writes.push(args);
      return { rows: [] };
    },
  };

  let count;
  try {
    count = await importFromCsv('sess-notmdb', tmpFile, { db: fakeDb }); // sem deps.tmdb
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  assert.equal(count, 4);
  // args[5] = tmdb_id (index), deve ser null quando sem tmdb
  assert.ok(writes.every(args => args[5] === null), 'tmdb_id deve ser null sem deps.tmdb');
});
