const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeCandidates, groundTitles, generateEssenceTitles, buildCandidates, traktRelatedCandidates, buildFtsMatch, ftsCandidates } = require('../src/candidates');
const { pickBestMatch } = require('../src/tmdb');

test('buildFtsMatch uses OR for sanitized phrases and skips short terms', () => {
  assert.equal(buildFtsMatch(['time loop', 'slow burn']), '"time loop" OR "slow burn"');
  assert.equal(buildFtsMatch(['ab', 'dystopia']), '"dystopia"');
  assert.equal(buildFtsMatch(['quo"te(s)']), '"quo te s"');
  assert.equal(buildFtsMatch([]), '');
});

test('ftsCandidates maps rows and degrades with no themes', async () => {
  let captured;
  const fakeDb = {
    execute: async ({ args }) => { captured = args; return { rows: [{ tmdb_id: 7 }, { tmdb_id: 8 }] }; },
  };
  const profile = { keywords: { 'time loop': 1, heist: 0.5 } };
  const out = await ftsCandidates({ profile, type: 'movie' }, { db: fakeDb });
  assert.deepEqual(out.map(c => c.tmdb_id), [7, 8]);
  assert.equal(out[0].sources[0].kind, 'fts');
  assert.equal(captured[0], 'movie');
  assert.match(captured[1], /"time loop"/);

  const empty = await ftsCandidates({ profile: { keywords: {} }, type: 'movie' }, { db: fakeDb });
  assert.deepEqual(empty, []);
});

test('ftsCandidates returns [] when FTS5 is unavailable', async () => {
  const fakeDb = { execute: async () => { throw new Error('no such module: fts5'); } };
  const out = await ftsCandidates({ profile: { keywords: { dystopia: 1 } }, type: 'movie' }, { db: fakeDb });
  assert.deepEqual(out, []);
});

// Fake db do cache de /related (trakt_related_cache). Registra writes.
function fakeRelatedDb({ cache = {}, writes = [] } = {}) {
  return {
    execute: async ({ sql, args }) => {
      if (/SELECT/.test(sql) && /trakt_related_cache/.test(sql)) {
        const [type, traktId] = args;
        const hit = cache[`${type}:${traktId}`];
        return hit
          ? { rows: [{ payload: JSON.stringify(hit.payload), updated_at: hit.updated_at }] }
          : { rows: [] };
      }
      if (/INSERT/.test(sql) && /trakt_related_cache/.test(sql)) {
        writes.push(args);
      }
      return { rows: [] };
    },
  };
}

test('mergeCandidates deduplica por tmdb_id e une sources/scores', () => {
  const a = [{ tmdb_id: 1, title: 'X', score: 1, sources: [{ kind: 'discover' }] }];
  const b = [{ tmdb_id: 1, title: 'X', score: 2, sources: [{ kind: 'ai' }] }];

  const merged = mergeCandidates(a, b);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].score, 3);
  assert.equal(merged[0].sources.length, 2);
});

test('groundTitles descarta título que não resolve no TMDB', async () => {
  const fakeTmdb = {
    searchTitle: async (title) => title === 'Real'
      ? [{ id: 7, title: 'Real', release_date: '2012-01-01', vote_count: 2000, popularity: 30, genre_ids: [18], original_language: 'en' }]
      : [],
    pickBestMatch,
  };

  const out = await groundTitles([{ title: 'Real', year: 2012 }, { title: 'Alucinado', year: 2012 }], 'movie', fakeTmdb);

  assert.equal(out.length, 1);
  assert.equal(out[0].tmdb_id, 7);
  assert.equal(out[0].sources[0].kind, 'ai');
});

test('generateEssenceTitles extrai JSON mesmo com ruído', async () => {
  const profile = { genres: { 18: 1 }, languages: { en: 1 }, topSeeds: [{ title: 'Drive' }] };
  const fakeAI = async () => '<think>x</think>{"items":[{"title":"Blue Ruin","year":2013}]}';

  const out = await generateEssenceTitles(profile, 'movie', fakeAI);

  assert.equal(out[0].title, 'Blue Ruin');
  assert.equal(out[0].year, 2013);
});

test('buildCandidates usa fallback discover amplo quando pool facetado vem pequeno', async () => {
  const fakeTmdb = {
    discover: async (_type, opts) => {
      if (!opts.genres?.length && !opts.language && opts.sortBy === 'popularity.desc') {
        return Array.from({ length: 30 }, (_, i) => ({
          id: 1000 + i,
          name: `S${i}`,
          first_air_date: '2020-01-01',
          vote_average: 7,
          vote_count: 500,
          genre_ids: [18],
          original_language: 'en',
        }));
      }
      return [];
    },
    getRecommendations: async () => [],
    getSimilar: async () => [],
  };
  const profile = { genres: { 18: 1 }, keywords: {}, languages: { en: 1 }, topSeeds: [] };

  const out = await buildCandidates({ profile, seeds: [], type: 'series', catalogId: 'watch-next' }, { tmdb: fakeTmdb });

  assert.ok(out.length >= 30);
});

test('buildCandidates generates AI candidates for watch-next, but not for new-for-you', async () => {
  let aiCalls = 0;
  const fakeTmdb = {
    discover: async () => [],
    getRecommendations: async () => [],
    getSimilar: async () => [],
    searchTitle: async () => [{
      id: 777,
      title: 'Ponte',
      release_date: '2020-01-01',
      vote_average: 7,
      vote_count: 500,
      genre_ids: [18],
      original_language: 'en',
    }],
    pickBestMatch,
  };
  const profile = { genres: { 18: 1 }, keywords: {}, languages: { en: 1 }, topSeeds: [{ title: 'Seed' }] };
  const callAI = async () => {
    aiCalls += 1;
    return '{"items":[{"title":"Ponte","year":2020}]}';
  };

  const watchNext = await buildCandidates({ profile, seeds: [], type: 'movie', catalogId: 'watch-next' }, { tmdb: fakeTmdb, callAI });
  const newForYou = await buildCandidates({ profile, seeds: [], type: 'movie', catalogId: 'new-for-you' }, { tmdb: fakeTmdb, callAI });

  assert.equal(watchNext.some(candidate => candidate.sources.some(source => source.kind === 'ai')), true);
  assert.equal(newForYou.some(candidate => candidate.sources.some(source => source.kind === 'ai')), false);
  assert.equal(aiCalls, 1);
});

test('traktRelatedCandidates: cache-hit não chama o Trakt e mapeia ids.tmdb', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cache = { 'movie:5': { payload: [{ title: 'Z', ids: { trakt: 50, tmdb: 500 } }], updated_at: now } };
  let getRelatedCalls = 0;
  const fakeTrakt = { getRelated: async () => { getRelatedCalls += 1; return []; } };
  const db = fakeRelatedDb({ cache });

  const out = await traktRelatedCandidates(
    { topWatched: [{ traktId: 5, tmdbId: 1, title: 'Seed' }], type: 'movie' },
    { trakt: fakeTrakt, db },
  );

  assert.equal(getRelatedCalls, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].tmdb_id, 500);
  assert.equal(out[0].sources[0].kind, 'trakt_related');
});

test('traktRelatedCandidates: cache-miss chama o Trakt, grava e mapeia metadados', async () => {
  const writes = [];
  let calls = 0;
  const fakeTrakt = {
    getRelated: async () => {
      calls += 1;
      return [{ title: 'Rel', year: 2015, ids: { trakt: 77, tmdb: 777 }, genres: ['drama'], language: 'en', rating: 8, votes: 1000 }];
    },
  };
  const db = fakeRelatedDb({ cache: {}, writes });

  const out = await traktRelatedCandidates(
    { topWatched: [{ traktId: 5, tmdbId: 1, title: 'Seed' }], type: 'movie' },
    { trakt: fakeTrakt, db },
  );

  assert.equal(calls, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].tmdb_id, 777);
  assert.equal(out[0].year, 2015);
  assert.deepEqual(out[0].genre_ids, [18]); // 'drama' -> 18
  assert.equal(writes.length, 1); // gravou no cache
});

test('traktRelatedCandidates: bloqueio/sem deps degrada para []', async () => {
  const blocked = { getRelated: async () => [] }; // wrapper já devolveu [] (bloqueio)
  const db = fakeRelatedDb({ cache: {} });
  assert.deepEqual(
    await traktRelatedCandidates({ topWatched: [{ traktId: 5, tmdbId: 1 }], type: 'movie' }, { trakt: blocked, db }),
    [],
  );

  // sem trakt nas deps -> [] sem tocar o db
  assert.deepEqual(await traktRelatedCandidates({ topWatched: [{ traktId: 5 }], type: 'movie' }, {}), []);
  // sem sementes -> []
  assert.deepEqual(await traktRelatedCandidates({ topWatched: [], type: 'movie' }, { trakt: blocked, db }), []);
});
