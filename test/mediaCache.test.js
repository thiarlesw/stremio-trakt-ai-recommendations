const { test } = require('node:test');
const assert = require('node:assert/strict');
const { enrichCandidates, loadCandidateMedia } = require('../src/mediaCache');

test('loadCandidateMedia usa cache fresco antes de chamar TMDB', async () => {
  let tmdbCalls = 0;
  const fakeDb = {
    execute: async () => ({
      rows: [{
        payload: JSON.stringify({ overview: 'Do cache', directors: [{ name: 'Cached' }] }),
        updated_at: Math.floor(Date.now() / 1000),
      }],
    }),
  };
  const fakeTmdb = {
    getFullMedia: async () => { tmdbCalls += 1; return { details: {}, credits: {}, keywords: [] }; },
  };

  const out = await loadCandidateMedia({ tmdb_id: 1, title: 'A' }, 'movie', { db: fakeDb, tmdb: fakeTmdb });

  assert.equal(out.overview, 'Do cache');
  assert.equal(out.directors[0].name, 'Cached');
  assert.equal(tmdbCalls, 0);
});

test('enrichCandidates respeita limite de concorrencia', async () => {
  let active = 0;
  let maxActive = 0;
  const fakeDb = { execute: async () => ({ rows: [] }) };
  const fakeTmdb = {
    getFullMedia: async (tmdbId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return { details: { title: `T${tmdbId}` }, credits: {}, keywords: [] };
    },
  };

  const out = await enrichCandidates(
    Array.from({ length: 8 }, (_, index) => ({ tmdb_id: index + 1 })),
    'movie',
    { db: fakeDb, tmdb: fakeTmdb, concurrency: 3 },
  );

  assert.equal(out.length, 8);
  assert.ok(maxActive > 1);
  assert.ok(maxActive <= 3);
});
