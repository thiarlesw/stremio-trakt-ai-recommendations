const { test } = require('node:test');
const assert = require('node:assert/strict');
const { didCuratorFail, finalOrder, filterCandidates, chooseFilteredCandidates, catalogsForBuild, catalogItemFromCandidate, fetchTraktSignal, buildTopWatched } = require('../src/builder');

test('didCuratorFail marca falha quando qualquer catálogo não retorna curadoria', () => {
  assert.equal(didCuratorFail('discovery', []), true);
  assert.equal(didCuratorFail('watch-next', []), true);
  assert.equal(didCuratorFail('new-for-you', []), true);
  assert.equal(didCuratorFail('discovery', [{ candidate: { tmdb_id: 1 } }]), false);
});

test('finalOrder: backfill honesto completa com determinístico (sem why de IA)', () => {
  const curated = [{ candidate: { tmdb_id: 1 }, why: 'ancorado em X' }];
  const ranked = [{ tmdb_id: 1 }, { tmdb_id: 2 }, { tmdb_id: 3 }];

  const out = finalOrder(curated, ranked, { target: 3 });

  assert.deepEqual(out.map(ref => ref.candidate.tmdb_id), [1, 2, 3]);
  assert.equal(out[0].why, 'ancorado em X');
  assert.equal(out[0]._backfill, undefined);
  assert.equal(out[1]._backfill, true);
  assert.ok(!out[1].why, 'backfill não inventa why de IA');
});

test('finalOrder: respeita target e não duplica os já curados', () => {
  const curated = [{ candidate: { tmdb_id: 1 }, why: 'a' }, { candidate: { tmdb_id: 2 }, why: 'b' }];
  const ranked = [{ tmdb_id: 2 }, { tmdb_id: 3 }, { tmdb_id: 4 }];

  const out = finalOrder(curated, ranked, { target: 3 });

  assert.deepEqual(out.map(ref => ref.candidate.tmdb_id), [1, 2, 3]);
});

test('filterCandidates aplica piso de ano quando configurado', () => {
  const debug = { dropped: { watched: 0, shown: 0, hidden: 0 } };
  const pool = [
    { tmdb_id: 1, year: 1918, vote_count: 1000 },
    { tmdb_id: 2, year: 2016, vote_count: 1000 },
  ];

  const out = filterCandidates(pool, {
    watchedSet: new Set(),
    shownIds: new Set(),
    hiddenIds: new Set(),
    minYear: 2005,
    debug,
  });

  assert.deepEqual(out.map(candidate => candidate.tmdb_id), [2]);
  assert.equal(debug.dropped.old, 1);
});

test('filterCandidates usa piso por-fonte: joia indie via embedding sobrevive, junk morre', () => {
  const debug = { dropped: { watched: 0, shown: 0, hidden: 0 } };
  const pool = [
    { tmdb_id: 1, year: 2018, vote_count: 50, sources: [{ kind: 'embedding' }] }, // vouch semântico, >=30 -> sobrevive
    { tmdb_id: 2, year: 2018, vote_count: 50, sources: [{ kind: 'discover' }] },  // sem vouch, <120 -> descartado
    { tmdb_id: 3, year: 2018, vote_count: 20, sources: [{ kind: 'embedding' }] }, // junk <30 -> morre mesmo via embedding
    { tmdb_id: 4, year: 2018, vote_count: 500, sources: [{ kind: 'discover' }] }, // popular normal -> passa
  ];

  const out = filterCandidates(pool, {
    watchedSet: new Set(),
    shownIds: new Set(),
    hiddenIds: new Set(),
    minVotes: 120,
    minVotesEmbedding: 30,
    debug,
  });

  assert.deepEqual(out.map(candidate => candidate.tmdb_id), [1, 4]);
});

test('chooseFilteredCandidates relaxa shown quando filtro estrito deixa pool escasso', () => {
  const pool = [
    { tmdb_id: 1, year: 2020, vote_count: 1000 },
    { tmdb_id: 2, year: 2020, vote_count: 1000 },
    { tmdb_id: 3, year: 2020, vote_count: 1000 },
  ];
  const debug = { dropped: { watched: 0, shown: 0, hidden: 0 } };

  const out = chooseFilteredCandidates(pool, {
    watchedSet: new Set(),
    shownIds: new Set([1, 2, 3]),
    hiddenIds: new Set(),
    minVotes: 100,
    minNeeded: 2,
    debug,
  });

  assert.deepEqual(out.map(candidate => candidate.tmdb_id), [1, 2, 3]);
  assert.equal(debug.relaxed_shown, true);
});

test('catalogsForBuild filtra catalogo opcional sem mudar padrao', () => {
  assert.equal(catalogsForBuild().length, 6);
  assert.deepEqual(catalogsForBuild({ catalog: 'watch-next', type: 'movie' }), [{ id: 'watch-next', type: 'movie' }]);
});

test('catalogItemFromCandidate reaproveita metadados cacheados com imdb_id', () => {
  const item = catalogItemFromCandidate({
    tmdb_id: 1,
    imdb_id: 'tt1',
    title: 'A',
    year: '2020',
    poster: 'p',
    backdrop: 'b',
    vote_average: 7.5,
    genres: ['Drama'],
    runtime: '90 min',
  }, 'porque sim');

  assert.deepEqual(item, {
    tmdb_id: 1,
    imdb_id: 'tt1',
    title: 'A',
    year: '2020',
    poster: 'p',
    backdrop: 'b',
    vote_average: 7.5,
    genres: ['Drama'],
    runtime: '90 min',
    why: 'porque sim',
  });
});

test('fetchTraktSignal: cache fresco evita o fetch ao Trakt', async () => {
  const now = Math.floor(Date.now() / 1000);
  const db = {
    execute: async ({ sql }) => {
      if (/SELECT/.test(sql) && /trakt_cache/.test(sql)) {
        return { rows: [{ payload: JSON.stringify([{ a: 1 }]), updated_at: now }] };
      }
      return { rows: [] };
    },
  };
  let fetcherCalls = 0;
  const out = await fetchTraktSignal('s1', 'movie', 'watched', async () => { fetcherCalls += 1; return [{ b: 2 }]; }, { db });

  assert.equal(fetcherCalls, 0);
  assert.deepEqual(out, [{ a: 1 }]);
});

test('fetchTraktSignal: cache-miss busca e grava', async () => {
  const writes = [];
  const db = {
    execute: async ({ sql, args }) => {
      if (/SELECT/.test(sql)) return { rows: [] };
      if (/INSERT/.test(sql)) writes.push(args);
      return { rows: [] };
    },
  };
  let calls = 0;
  const out = await fetchTraktSignal('s1', 'movie', 'watched', async () => { calls += 1; return [{ b: 2 }]; }, { db });

  assert.equal(calls, 1);
  assert.deepEqual(out, [{ b: 2 }]);
  assert.equal(writes.length, 1);
});

test('fetchTraktSignal: bloqueio (vazio) cai para o cache velho', async () => {
  const stale = Math.floor(Date.now() / 1000) - 100000; // > 6h
  const db = {
    execute: async ({ sql }) => {
      if (/SELECT/.test(sql)) return { rows: [{ payload: JSON.stringify([{ old: 1 }]), updated_at: stale }] };
      return { rows: [] };
    },
  };
  let calls = 0;
  const out = await fetchTraktSignal('s1', 'movie', 'watched', async () => { calls += 1; return []; }, { db });

  assert.equal(calls, 1); // cache velho -> tentou buscar
  assert.deepEqual(out, [{ old: 1 }]); // bloqueado -> caiu no cache velho
});

test('buildTopWatched extrai trakt id + tmdb id + peso e ignora itens sem tmdb', () => {
  const watched = [
    { movie: { ids: { trakt: 10, tmdb: 100 }, title: 'A' }, plays: 3, last_watched_at: '2026-06-01T00:00:00Z' },
    { movie: { ids: { trakt: 11, tmdb: 101 }, title: 'B' }, plays: 1, last_watched_at: '2018-01-01T00:00:00Z' },
    { movie: { ids: { trakt: 12 }, title: 'SemTmdb' }, plays: 1 },
  ];

  const top = buildTopWatched(watched, 'movie', 5);

  assert.equal(top.length, 2);
  assert.equal(top[0].tmdbId, 100);
  assert.equal(top[0].traktId, 10);
  assert.equal(typeof top[0].weight, 'number');
});
