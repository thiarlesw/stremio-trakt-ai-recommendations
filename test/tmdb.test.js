'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmdbFetch, parseDetails, parseCredits, parseKeywords, pickBestMatch } = require('../src/tmdb');

function res429() {
  return {
    status: 429,
    ok: false,
    headers: { get: (h) => (h === 'Retry-After' ? '0' : null) },
    json: async () => ({}),
  };
}
function res200(body) {
  return { status: 200, ok: true, headers: { get: () => null }, json: async () => body };
}

test('tmdbFetch: 429 persistente desiste após o teto (não loopa infinito)', async () => {
  let calls = 0;
  let sleeps = 0;
  const out = await tmdbFetch('/movie/1', {}, {
    fetchImpl: async () => { calls += 1; return res429(); },
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(out, null, 'retorna null ao esgotar tentativas');
  assert.equal(calls, 3, 'chamada inicial + 2 retries (teto=2)');
  assert.equal(sleeps, 2, 'dormiu uma vez por retry');
});

test('tmdbFetch: 429 transitório se recupera no retry', async () => {
  let calls = 0;
  const out = await tmdbFetch('/movie/1', {}, {
    fetchImpl: async () => { calls += 1; return calls < 2 ? res429() : res200({ ok: 1 }); },
    sleep: async () => {},
  });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(calls, 2);
});

test('parseCredits movie: extrai diretor do crew e limita elenco a 5', () => {
  const data = {
    credits: {
      crew: [{ id: 1, name: 'Dir', job: 'Director' }, { id: 2, name: 'W', job: 'Writer' }],
      cast: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `A${i}` })),
    },
  };
  const c = parseCredits(data, 'movie');
  assert.equal(c.directors.length, 1);
  assert.equal(c.directors[0].name, 'Dir');
  assert.equal(c.cast.length, 5);
});

test('parseCredits series: usa created_by e aggregate_credits', () => {
  const data = {
    created_by: [{ id: 9, name: 'Creator' }],
    aggregate_credits: { cast: [{ id: 1, name: 'Star' }] },
  };
  const c = parseCredits(data, 'series');
  assert.equal(c.directors[0].name, 'Creator');
  assert.equal(c.cast[0].name, 'Star');
});

test('parseKeywords: movie usa .keywords, series usa .results, filtra denylist', () => {
  const movie = parseKeywords({ keywords: { keywords: [{ name: 'heist' }, { name: 'time loop' }] } });
  assert.deepEqual(movie.map(k => k.name), ['time loop'], "'heist' está na denylist");

  const series = parseKeywords({ keywords: { results: [{ name: 'dystopia' }] } });
  assert.deepEqual(series.map(k => k.name), ['dystopia']);

  assert.deepEqual(parseKeywords({}), [], 'sem keywords → []');
});

test('pickBestMatch: casa pelo título ORIGINAL quando o name vem localizado (pt-BR)', () => {
  const results = [{
    id: 69478,
    name: 'O Conto da Aia',
    original_name: "The Handmaid's Tale",
    first_air_date: '2017-04-26',
    vote_count: 3000,
    popularity: 80,
  }];
  const match = pickBestMatch(results, { title: "The Handmaid's Tale", type: 'series' });
  assert.ok(match, 'deve casar pelo título original mesmo com name pt-BR');
  assert.equal(match.id, 69478);
});

test('pickBestMatch: sem casamento de título → null (popularidade não salva)', () => {
  const results = [{ id: 1, name: 'Outra Coisa', original_name: 'Something Else', vote_count: 9999, popularity: 99 }];
  assert.equal(pickBestMatch(results, { title: 'Inexistente XYZ', type: 'series' }), null);
});

test('parseDetails: null quando não há payload; monta campos básicos', () => {
  assert.equal(parseDetails(null, 1, 'movie'), null);
  const d = parseDetails(
    { title: 'X', release_date: '2021-05-01', external_ids: { imdb_id: 'tt1' }, vote_average: 7.84 },
    1, 'movie',
  );
  assert.equal(d.title, 'X');
  assert.equal(d.year, '2021');
  assert.equal(d.imdb_id, 'tt1');
  assert.equal(d.vote_average, 7.8);
});

test('parseDetails: inclui vote_count e popularity (não somem no cache)', () => {
  const d = parseDetails(
    { title: 'Y', release_date: '2020-01-01', vote_average: 7, vote_count: 1234, popularity: 88.5 },
    9, 'movie',
  );
  assert.equal(d.vote_count, 1234);
  assert.equal(d.popularity, 88.5);
});
