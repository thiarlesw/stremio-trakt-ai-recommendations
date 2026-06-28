const { test } = require('node:test');
const assert = require('node:assert/strict');
const { curate, extractFirstJSON, buildPrompt } = require('../src/curator');

test('extractFirstJSON acha JSON dentro de ruído e blocos de raciocínio', () => {
  const obj = extractFirstJSON('<think>oi</think> texto {"items":[{"id":2,"why":"porque X"}]} fim');

  assert.equal(obj.items[0].id, 2);
});

test('curate ignora ids fora do input', async () => {
  const top = [
    { tmdb_id: 10, title: 'A', _idx: 1, year: 2010, genre_ids: [18], vote_average: 7.2, sources: [] },
    { tmdb_id: 20, title: 'B', _idx: 2, year: 2011, genre_ids: [80], vote_average: 7.4, sources: [] },
  ];
  const fakeAI = async () => '{"items":[{"id":2,"why":"ancorado em algo, ótimo ritmo"},{"id":99,"why":"inexistente"}]}';

  const out = await curate(top, { profile: {}, type: 'movie', catalogId: 'watch-next' }, fakeAI);

  assert.equal(out.length, 1);
  assert.equal(out[0].candidate.tmdb_id, 20);
});

test('curate aceita id numerico como string sem aceitar titulo livre', async () => {
  const top = [
    { tmdb_id: 10, title: 'A', _idx: 1, year: 2010, genre_ids: [18], vote_average: 7.2, sources: [] },
  ];
  const fakeAI = async () => '{"items":[{"id":"1","title":"Inventado","why":"ancorado em algo concreto porque funciona"}]}';

  const out = await curate(top, { profile: {}, type: 'movie', catalogId: 'watch-next' }, fakeAI);

  assert.equal(out.length, 1);
  assert.equal(out[0].candidate.tmdb_id, 10);
});

test('curate tenta 2x: falha na 1ª, acerta na 2ª', async () => {
  const top = [{ tmdb_id: 10, title: 'A', _idx: 1, year: 2010, genre_ids: [18], vote_average: 7.2, sources: [] }];
  let calls = 0;
  const fakeAI = async () => {
    calls += 1;
    if (calls === 1) return 'lixo sem json';
    return '{"items":[{"id":1,"why":"ancorado em algo concreto porque encaixa"}]}';
  };

  const out = await curate(top, { profile: {}, type: 'movie', catalogId: 'watch-next' }, fakeAI);

  assert.equal(calls, 2, 'deve tentar 2x de verdade');
  assert.equal(out.length, 1);
  assert.equal(out[0].candidate.tmdb_id, 10);
});

test('buildPrompt asks for 30 ids and includes rich metadata plus rewatch signals', () => {
  const top = [{
    tmdb_id: 10,
    title: 'A',
    _idx: 1,
    year: 2010,
    genre_ids: [18],
    vote_average: 7.2,
    sources: [],
    overview: 'Drama sobre poder e identidade.',
    directors: [{ name: 'Diretora X' }],
    cast: [{ name: 'Atriz Y' }],
    keywords: [{ name: 'political intrigue' }],
    original_language: 'fr',
  }];
  const profile = {
    topSeeds: [
      { title: 'Seed Forte', plays: 3, weight: 4.5, lastWatchedAt: '2026-01-01' },
    ],
  };

  const prompt = buildPrompt(top, { profile, type: 'movie', catalogId: 'watch-next' });

  assert.match(prompt, /Choose exactly 30/i);
  assert.match(prompt, /Do not stop at 20/i);
  assert.match(prompt, /Drama sobre poder e identidade/);
  assert.match(prompt, /Diretora X/);
  assert.match(prompt, /political intrigue/);
  assert.match(prompt, /Seed Forte.*3x/i);
});

test('buildPrompt includes inferred profile and requires variety', () => {
  const top = [{ tmdb_id: 10, title: 'A', _idx: 1, year: 2010, genre_ids: [18], vote_average: 7.2, sources: [] }];
  const profile = {
    topSeeds: [{ title: 'Seed' }],
    genres: { 18: 1 },
    keywords: { 'time loop': 1, 'slow burn': 0.6 },
    people: { 'Villeneuve': 1 },
    averseGenres: [27, 16],
  };

  const prompt = buildPrompt(top, { profile, type: 'movie', catalogId: 'discovery' });

  assert.match(prompt, /Inferred profile/);
  assert.match(prompt, /time loop/);
  assert.match(prompt, /Villeneuve/);
  assert.match(prompt, /Almost never watches/i);
  assert.match(prompt, /Variety is mandatory/);
});
