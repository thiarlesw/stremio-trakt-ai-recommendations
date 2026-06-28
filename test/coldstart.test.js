'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadColdStartSeeds, buildUserRatingEvents, injectExternalSignals } = require('../src/coldStartUtils');
const { coldStartCandidates, crossTypeEssenceCandidates, embeddingCandidates } = require('../src/candidates');
const { filterCandidates, buildUserVectorForSeeds } = require('../src/builder');
const { buildUserVector } = require('../src/embeddings');
const { pickBestMatch } = require('../src/tmdb');

test('loadColdStartSeeds retorna seeds do banco com tmdbId e weight', async () => {
  const fakeDb = {
    execute: async ({ sql }) => {
      if (/cold_start_seeds/.test(sql)) {
        return { rows: [{ tmdb_id: 123, title: 'Inception', weight: 5 }] };
      }
      return { rows: [] };
    },
  };

  const seeds = await loadColdStartSeeds('sess1', 'movie', { db: fakeDb });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].tmdbId, 123);
  assert.equal(seeds[0].title, 'Inception');
  assert.equal(seeds[0].weight, 5);
});

test('loadColdStartSeeds retorna [] quando banco vazio ou em erro', async () => {
  const emptyDb = { execute: async () => ({ rows: [] }) };
  assert.deepEqual(await loadColdStartSeeds('sess1', 'movie', { db: emptyDb }), []);

  const errorDb = { execute: async () => { throw new Error('db error'); } };
  assert.deepEqual(await loadColdStartSeeds('sess1', 'movie', { db: errorDb }), []);
});

test('buildUserRatingEvents: 8-10 positivo forte, 5-7 leve, 1-4 negativo', () => {
  const rows = [
    { tmdb_id: 1, rating: 9, title: 'A', type: 'movie' },
    { tmdb_id: 2, rating: 6, title: 'B', type: 'movie' },
    { tmdb_id: 3, rating: 3, title: 'C', type: 'movie' },
    { tmdb_id: 0, rating: 8, title: 'SemTmdb', type: 'movie' }, // tmdb_id 0 ignorado
  ];

  const { positiveEvents, negativeEvents } = buildUserRatingEvents(rows);

  assert.equal(positiveEvents.length, 2, 'rating 9 e 6 devem ser positivos');
  assert.equal(negativeEvents.length, 1, 'rating 3 deve ser negativo');
  assert.ok(positiveEvents[0].weight > positiveEvents[1].weight, 'rating 9 pesa mais que 6');
  assert.equal(positiveEvents[1].weight, 1.0, 'rating 5-7: peso fixo 1.0');
  assert.equal(positiveEvents[0].tmdbId, 1);
  assert.equal(negativeEvents[0].tmdbId, 3);
});

test('buildUserRatingEvents: rating fora do range (0, 11) e tmdb_id nulo sao ignorados', () => {
  const rows = [
    { tmdb_id: 5, rating: 0, title: 'Zero', type: 'movie' },
    { tmdb_id: 6, rating: 11, title: 'Onze', type: 'movie' },
    { tmdb_id: null, rating: 8, title: 'NullId', type: 'movie' },
  ];

  const { positiveEvents, negativeEvents } = buildUserRatingEvents(rows);

  assert.equal(positiveEvents.length, 0);
  assert.equal(negativeEvents.length, 0);
});

test('coldStartCandidates retorna trending filtrado por vote_count >= 50', async () => {
  const fakeTmdb = {
    getTrending: async () => [
      { id: 1, title: 'Popular', vote_count: 200, release_date: '2024-01-01', vote_average: 7.5, genre_ids: [28], original_language: 'en' },
      { id: 2, title: 'Obscuro', vote_count: 10, release_date: '2024-01-01', vote_average: 5.0, genre_ids: [], original_language: 'pt' },
      { id: 3, title: 'Medio', vote_count: 50, release_date: '2024-01-01', vote_average: 6.0, genre_ids: [18], original_language: 'fr' },
    ],
  };

  const out = await coldStartCandidates({ type: 'movie' }, { tmdb: fakeTmdb });

  assert.equal(out.length, 2, 'apenas itens com vote_count >= 50 passam');
  assert.ok(out.every(c => c.sources[0].kind === 'trending'));
  assert.ok(out.some(c => c.tmdb_id === 1));
  assert.ok(out.some(c => c.tmdb_id === 3));
});

test('coldStartCandidates degrada para [] sem tmdb', async () => {
  assert.deepEqual(await coldStartCandidates({ type: 'movie' }, {}), []);
  assert.deepEqual(await coldStartCandidates({ type: 'series' }, { tmdb: null }), []);
});

test('coldStartCandidates degrada para [] em erro de rede', async () => {
  const brokenTmdb = {
    getTrending: async () => { throw new Error('network error'); },
  };
  const out = await coldStartCandidates({ type: 'movie' }, { tmdb: brokenTmdb });
  assert.deepEqual(out, []);
});

test('injectExternalSignals: cold_start_seeds sao prependidas as seeds existentes', async () => {
  const fakeDb = {
    execute: async ({ sql }) => {
      if (/cold_start_seeds/.test(sql)) {
        return { rows: [{ tmdb_id: 42, title: 'Cold Seed', weight: 5 }] };
      }
      if (/user_ratings/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const ctx = {
    // seed comportamental 99 tem evento correspondente (como em produção)
    events: [{ tmdbId: 99, title: 'Original', weight: 2, genres: [], keywords: [], people: [] }],
    negativeEvents: [],
    profile: { topSeeds: [{ tmdbId: 99, title: 'Original', weight: 2 }], genres: {}, languages: {}, keywords: {}, people: {}, decades: {}, runtime: { mean: 0, std: 0 }, confidence: 0 },
    mood: {},
    negative: {},
    seeds: [{ tmdbId: 99, title: 'Original', weight: 2 }],
    hiddenIds: new Set(),
  };

  await injectExternalSignals('sess1', ctx, 'movie', { db: fakeDb });

  // cold seed (peso 5) remodela o perfil e entra nas seeds, à frente da original (peso 2)
  assert.ok(ctx.seeds.some(s => s.tmdbId === 42), 'cold seed entra nas seeds');
  assert.ok(ctx.seeds.some(s => s.tmdbId === 99), 'seed original (com evento) preservada');
  assert.equal(ctx.seeds[0].tmdbId, 42, 'cold seed (peso alto) vem primeiro');
  assert.ok(ctx.coldSeedIds.has(42), 'coldSeedIds registrado');
});

test('injectExternalSignals: user_ratings positivas extendem eventos e negativas o perfil negativo', async () => {
  const fakeDb = {
    execute: async ({ sql }) => {
      if (/user_ratings/.test(sql)) {
        return {
          rows: [
            { tmdb_id: 11, rating: 9, title: 'Favorito', type: 'movie' },
            { tmdb_id: 22, rating: 2, title: 'Detestado', type: 'movie' },
          ],
        };
      }
      if (/cold_start_seeds/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const ctx = {
    events: [],
    negativeEvents: [],
    profile: { topSeeds: [], genres: {}, languages: {}, keywords: {}, people: {}, decades: {}, runtime: { mean: 0, std: 0 }, confidence: 0 },
    mood: {},
    negative: { genres: {}, keywords: {}, people: {}, languages: {} },
    seeds: [],
    hiddenIds: new Set(),
  };

  await injectExternalSignals('sess1', ctx, 'movie', { db: fakeDb });

  // Rating 9 -> evento positivo -> seeds rebuild from profile
  assert.ok(ctx.events.some(e => e.tmdbId === 11), 'favorito entra nos eventos positivos');
  // Rating 2 -> evento negativo -> hiddenIds
  assert.ok(ctx.hiddenIds.has(22), 'detestado entra nos hidden ids');
});

test('injectExternalSignals: usuario com historico normal nao sofre cold start (seeds >= 3)', async () => {
  const fakeDb = {
    execute: async ({ sql }) => {
      if (/cold_start_seeds/.test(sql)) return { rows: [] };
      if (/user_ratings/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const originalSeeds = [
    { tmdbId: 1, title: 'A', weight: 3 },
    { tmdbId: 2, title: 'B', weight: 2 },
    { tmdbId: 3, title: 'C', weight: 1 },
  ];

  const ctx = {
    events: [],
    negativeEvents: [],
    profile: { topSeeds: originalSeeds, genres: {}, languages: {}, keywords: {}, people: {}, decades: {}, runtime: { mean: 0, std: 0 }, confidence: 0.5 },
    mood: {},
    negative: {},
    seeds: [...originalSeeds],
    hiddenIds: new Set(),
  };

  await injectExternalSignals('sess1', ctx, 'movie', { db: fakeDb });

  // Sem cold seeds e sem ratings: seeds devem permanecer iguais
  assert.equal(ctx.seeds.length, 3);
  assert.deepEqual(ctx.seeds.map(s => s.tmdbId), [1, 2, 3]);
});

// --- Correction A ---

test('filterCandidates exclui candidatos cujo tmdb_id está em cold_start_seeds (coldSeedIds)', () => {
  const debug = { dropped: { watched: 0, shown: 0, hidden: 0 } };
  const pool = [
    { tmdb_id: 42, vote_count: 500 },   // cold seed — deve ser excluído
    { tmdb_id: 99, vote_count: 500 },   // candidato normal — deve passar
  ];

  const out = filterCandidates(pool, {
    watchedSet: new Set(),
    shownIds: new Set(),
    hiddenIds: new Set(),
    coldSeedIds: new Set([42]),
    debug,
  });

  assert.equal(out.length, 1, 'apenas o candidato não-seed deve passar');
  assert.equal(out[0].tmdb_id, 99);
  assert.equal(debug.dropped.cold_seed, 1, 'deve contabilizar dropped.cold_seed');
});

test('injectExternalSignals armazena coldSeedIds no contexto', async () => {
  const fakeDb = {
    execute: async ({ sql }) => {
      if (/cold_start_seeds/.test(sql)) {
        return { rows: [{ tmdb_id: 42, title: 'Inception', weight: 5 }] };
      }
      if (/user_ratings/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };

  const ctx = {
    events: [],
    negativeEvents: [],
    profile: { topSeeds: [], genres: {}, languages: {}, keywords: {}, people: {}, decades: {}, runtime: { mean: 0, std: 0 }, confidence: 0 },
    mood: {},
    negative: {},
    seeds: [],
    hiddenIds: new Set(),
  };

  await injectExternalSignals('sess1', ctx, 'movie', { db: fakeDb });

  assert.ok(ctx.coldSeedIds instanceof Set, 'coldSeedIds deve ser um Set');
  assert.ok(ctx.coldSeedIds.has(42), 'cold seed tmdb_id 42 deve estar em coldSeedIds');
  assert.ok(Array.isArray(ctx.coldSeeds), 'coldSeeds deve ser array');
  assert.equal(ctx.coldSeeds[0].tmdbId, 42);
});

// --- Addition B ---

test('crossTypeEssenceCandidates: seed de série gera candidatos de filme via AI (cross_essence)', async () => {
  const fakeAI = async () => '{"items":[{"title":"FilmeX","year":2020}]}';
  const fakeTmdb = {
    searchTitle: async () => [{
      id: 777,
      title: 'FilmeX',
      release_date: '2020-01-01',
      vote_average: 7.5,
      vote_count: 500,
      genre_ids: [18],
      original_language: 'pt',
    }],
    pickBestMatch,
  };

  const otherTypeSeeds = [{ tmdbId: 42, title: 'Série Favorita', weight: 5 }];
  const otherTypeProfile = {
    topSeeds: [{ title: 'Série Favorita' }],
    genres: { 18: 2 },
    languages: { pt: 1 },
  };

  const candidates = await crossTypeEssenceCandidates(
    { otherTypeProfile, otherTypeSeeds, targetType: 'movie' },
    { callAI: fakeAI, tmdb: fakeTmdb },
  );

  assert.ok(candidates.length > 0, 'deve gerar candidatos de filme');
  assert.ok(candidates.some(c => c.tmdb_id === 777), 'FilmeX deve estar nos candidatos');
  assert.ok(
    candidates.every(c => c.sources[0].kind === 'cross_essence'),
    'fonte deve ser cross_essence',
  );
});

test('crossTypeEssenceCandidates degrada para [] sem callAI, sem tmdb ou sem seeds', async () => {
  const fakeAI = async () => '{"items":[{"title":"X","year":2020}]}';
  const fakeTmdb = { searchTitle: async () => [], pickBestMatch };

  assert.deepEqual(
    await crossTypeEssenceCandidates({ otherTypeSeeds: [], targetType: 'movie' }, { callAI: fakeAI, tmdb: fakeTmdb }),
    [],
    'sem seeds -> []',
  );
  assert.deepEqual(
    await crossTypeEssenceCandidates({ otherTypeSeeds: [{ tmdbId: 1, title: 'X' }], targetType: 'movie' }, {}),
    [],
    'sem deps -> []',
  );
});

// --- Addition C ---

test('embeddingCandidates cross-type: userVec construído a partir de série encontra filmes similares', async () => {
  // Vetores simples: série 42 e filme 101 são próximos; filme 202 é oposto
  const seriesVec = [1.0, 0.0];
  const movieVec = [0.9, 0.1];   // similar a seriesVec
  const noiseVec = [-1.0, 0.0];  // oposto — sim <= 0, não deve aparecer

  const fakeDb = {
    execute: async ({ sql, args }) => {
      const isEmbedding = /media_embeddings/.test(sql);
      if (!isEmbedding) return { rows: [] };

      // getCachedVecs para série (buildUserVector passa IN (...))
      if (args[0] === 'series') {
        return { rows: [{ tmdb_id: 42, vec: JSON.stringify(seriesVec) }] };
      }
      // embeddingCandidates busca todos do tipo='movie'
      if (args[0] === 'movie') {
        return {
          rows: [
            { tmdb_id: 101, vec: JSON.stringify(movieVec) },
            { tmdb_id: 202, vec: JSON.stringify(noiseVec) },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const seriesSeeds = [{ tmdbId: 42, title: 'Série Favorita', weight: 5 }];
  const crossVec = await buildUserVector('series', seriesSeeds, { db: fakeDb });

  assert.ok(Array.isArray(crossVec), 'deve construir userVec das seeds de série');
  assert.equal(crossVec.length, 2);

  const candidates = await embeddingCandidates({ userVec: crossVec, type: 'movie' }, { db: fakeDb });

  assert.ok(candidates.length > 0, 'deve encontrar filmes similares às séries');
  assert.ok(candidates.some(c => c.tmdb_id === 101), 'filme similar deve aparecer');
  assert.ok(!candidates.some(c => c.tmdb_id === 202), 'vetor oposto (sim<=0) não deve aparecer');
});

// Regressão: o cross-type embedding (Addition C) só funciona se os vetores das
// cold seeds existirem em media_embeddings. buildUserVectorForSeeds é o único ponto
// que os gera (ensureVec). Este teste trava o contrato: TODA seed passada — inclusive
// as cold seeds injetadas depois — recebe ensureVec. Se alguém voltar a calcular o
// userVec antes da injeção das cold seeds, os vetores nunca seriam cacheados e o
// cross-embedding morreria silenciosamente em produção (teste verde, recs ruins).
test('buildUserVectorForSeeds garante (ensureVec) o vetor de TODAS as seeds, incluindo cold seeds', async () => {
  const ensured = [];
  const fakeEmbeddings = {
    hasProvider: () => true,
    ensureVec: async (type, media) => { ensured.push(media.tmdb_id); return [1, 0, 0]; },
    buildUserVector: async () => [0.5, 0.5, 0],
  };
  const fakeMediaCache = {
    loadCandidateMedia: async (cand) => ({ tmdb_id: cand.tmdb_id, title: cand.title }),
  };

  // Mistura de seed comportamental (1) com cold seeds injetadas (42, 99)
  const seeds = [
    { tmdbId: 1, title: 'Assistida' },
    { tmdbId: 42, title: 'Outlander' },
    { tmdbId: 99, title: 'Silo' },
  ];

  const vec = await buildUserVectorForSeeds('series', seeds, {
    embeddings: fakeEmbeddings,
    mediaCache: fakeMediaCache,
    tmdb: {},
  });

  assert.deepEqual(ensured, [1, 42, 99], 'ensureVec deve rodar para cada seed (cold seeds incluídas)');
  assert.deepEqual(vec, [0.5, 0.5, 0], 'retorna o userVec construído sobre as seeds finais');
});

test('buildUserVectorForSeeds degrada para null sem provedor de embedding', async () => {
  const fakeEmbeddings = { hasProvider: () => false, ensureVec: async () => null, buildUserVector: async () => null };
  const vec = await buildUserVectorForSeeds('movie', [{ tmdbId: 1, title: 'x' }], { embeddings: fakeEmbeddings });
  assert.equal(vec, null);
});
