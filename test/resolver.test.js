const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickBestMatch } = require('../src/tmdb');

test('pickBestMatch escolhe título exato com ano próximo', () => {
  const results = [
    { id: 1, title: 'Drive', release_date: '2011-09-16', popularity: 40, vote_count: 6000 },
    { id: 2, title: 'Drive', release_date: '1997-01-01', popularity: 2, vote_count: 30 },
  ];

  const match = pickBestMatch(results, { title: 'Drive', year: 2011, type: 'movie' });

  assert.equal(match.id, 1);
});

test('pickBestMatch retorna null quando nada bate com confiança', () => {
  const results = [
    { id: 9, title: 'Outra Coisa', release_date: '2000-01-01', popularity: 1, vote_count: 5 },
  ];

  const match = pickBestMatch(results, { title: 'Filme Inexistente XYZ', year: 2011, type: 'movie' });

  assert.equal(match, null);
});

test('pickBestMatch entende name/first_air_date para séries', () => {
  const results = [
    { id: 42, name: 'The Bear', first_air_date: '2022-06-23', popularity: 60, vote_count: 1200 },
  ];

  const match = pickBestMatch(results, { title: 'The Bear', year: 2022, type: 'series' });

  assert.equal(match.id, 42);
});
