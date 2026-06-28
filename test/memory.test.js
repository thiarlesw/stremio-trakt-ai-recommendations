const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  recommendationMemoryPenalty,
  serializeSources,
  eventRows,
} = require('../src/memory');

test('recommendationMemoryPenalty cresce com repetição ignorada', () => {
  const once = recommendationMemoryPenalty({ times_recommended: 1 });
  const many = recommendationMemoryPenalty({ times_recommended: 5 });

  assert.ok(many > once);
});

test('recommendationMemoryPenalty zera quando recomendação foi aceita', () => {
  const penalty = recommendationMemoryPenalty({ times_recommended: 5, accepted_at: 123 });

  assert.equal(penalty, 0);
});

test('serializeSources mantém fontes em JSON estável', () => {
  const json = serializeSources([{ kind: 'discover' }, { kind: 'ai' }]);
  const round = JSON.parse(json);

  assert.equal(round.length, 2);
  assert.equal(round[1].kind, 'ai');
});

test('eventRows normaliza eventos para persistência', () => {
  const rows = eventRows('s1', 'movie', 'watched', [
    { tmdbId: 10, title: 'Drive', occurredAt: 100, weight: 2, genres: [18] },
  ]);

  assert.equal(rows[0].session_id, 's1');
  assert.equal(rows[0].event_type, 'watched');
  assert.equal(rows[0].tmdb_id, 10);
  assert.equal(JSON.parse(rows[0].raw_json).genres[0], 18);
});
