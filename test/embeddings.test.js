const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mediaText,
  cosine,
  embed,
  getCachedVecs,
  ensureVec,
  buildUserVector,
  buildAcceptedVector,
  buildRejectedVector,
} = require('../src/embeddings');
const { scoreCandidate, rankAndDiversify } = require('../src/score');

// Fake db: devolve linhas para os ids presentes no store, por type.
function fakeDbWith(store) {
  return {
    execute: async ({ args }) => {
      const type = args[0];
      const ids = args.slice(1).map(Number);
      const rows = [];
      for (const id of ids) {
        const vec = store[`${type}:${id}`];
        if (vec) rows.push({ tmdb_id: id, vec: JSON.stringify(vec) });
      }
      return { rows };
    },
  };
}

// Fake db do loop de aprendizado: ramifica por tabela no SQL.
function fakeLearningDb({ accepted = [], negative = [], vecs = {} }) {
  return {
    execute: async ({ sql, args }) => {
      if (/recommendation_memory/.test(sql)) {
        return { rows: accepted.map(id => ({ tmdb_id: id })) };
      }
      if (/user_events/.test(sql)) {
        return { rows: negative.map(id => ({ tmdb_id: id })) };
      }
      const type = args[0];
      const ids = args.slice(1).map(Number);
      const rows = [];
      for (const id of ids) {
        const vec = vecs[`${type}:${id}`];
        if (vec) rows.push({ tmdb_id: id, vec: JSON.stringify(vec) });
      }
      return { rows };
    },
  };
}

function round(arr, digits = 4) {
  const f = 10 ** digits;
  return arr.map(v => Math.round(v * f) / f);
}

test('cosine: identicos=1, ortogonais=0, defensivo=0', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine(null, [1, 2]), 0);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(cosine([0, 0], [0, 0]), 0);
  const partial = cosine([1, 1], [1, 0]);
  assert.ok(partial > 0 && partial < 1);
});

test('mediaText monta texto rico e estavel', () => {
  const text = mediaText({
    title: 'Drive',
    year: 2011,
    overview: 'A driver.',
    genres: ['Crime', 'Drama'],
    directors: [{ name: 'Refn' }],
    cast: [{ name: 'Gosling' }, { name: 'Mulligan' }],
    keywords: [{ name: 'heist' }, { name: 'neo-noir' }],
  });

  assert.match(text, /^Drive \(2011\)\. A driver\./);
  assert.match(text, /Gêneros: Crime, Drama/);
  assert.match(text, /Direção: Refn/);
  assert.match(text, /Elenco: Gosling, Mulligan/);
  assert.match(text, /Temas\(keywords\): heist, neo-noir/);
});

test('mediaText e PURA e defensiva com payload vazio', () => {
  assert.doesNotThrow(() => mediaText());
  assert.equal(typeof mediaText({}), 'string');
  assert.equal(mediaText({ title: 'Só Título' }), 'Só Título.');
});

test('embed retorna null sem env (nao bate na rede)', async () => {
  const base = process.env.EMBED_BASE_URL;
  const key = process.env.EMBED_API_KEY;
  delete process.env.EMBED_BASE_URL;
  delete process.env.EMBED_API_KEY;
  try {
    assert.equal(await embed('qualquer coisa'), null);
  } finally {
    if (base !== undefined) process.env.EMBED_BASE_URL = base;
    if (key !== undefined) process.env.EMBED_API_KEY = key;
  }
});

test('ensureVec usa cache e nao gera quando sem env', async () => {
  // cache hit: devolve vetor sem chamar embed
  const cachedDb = fakeDbWith({ 'movie:1': [0.1, 0.2, 0.3] });
  const hit = await ensureVec('movie', { tmdb_id: 1, title: 'A' }, { db: cachedDb });
  assert.deepEqual(hit, [0.1, 0.2, 0.3]);

  // cache miss + sem env => null, sem rede
  const base = process.env.EMBED_BASE_URL;
  const key = process.env.EMBED_API_KEY;
  delete process.env.EMBED_BASE_URL;
  delete process.env.EMBED_API_KEY;
  try {
    const missDb = fakeDbWith({});
    const miss = await ensureVec('movie', { tmdb_id: 99, title: 'B' }, { db: missDb });
    assert.equal(miss, null);
  } finally {
    if (base !== undefined) process.env.EMBED_BASE_URL = base;
    if (key !== undefined) process.env.EMBED_API_KEY = key;
  }
});

test('getCachedVecs devolve Map e ignora linhas corrompidas', async () => {
  const corruptDb = {
    execute: async () => ({
      rows: [
        { tmdb_id: 1, vec: '[1,2,3]' },
        { tmdb_id: 2, vec: 'nao-e-json' },
      ],
    }),
  };
  const map = await getCachedVecs('movie', [1, 2], { db: corruptDb });
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(1), [1, 2, 3]);
});

test('buildUserVector faz media ponderada dos vetores cacheados', async () => {
  const db = fakeDbWith({ 'movie:1': [1, 0, 0], 'movie:2': [0, 1, 0] });
  const seeds = [
    { tmdbId: 1, weight: 3 },
    { tmdbId: 2, weight: 1 },
    { tmdbId: 3, weight: 5 }, // sem vetor em cache -> ignorada
  ];
  const userVec = await buildUserVector('movie', seeds, { db });
  // (3*[1,0,0] + 1*[0,1,0]) / 4 = [0.75, 0.25, 0]
  assert.deepEqual(round(userVec), [0.75, 0.25, 0]);
});

test('buildUserVector retorna null quando nenhuma seed tem vetor', async () => {
  const db = fakeDbWith({});
  const userVec = await buildUserVector('movie', [{ tmdbId: 1, weight: 1 }], { db });
  assert.equal(userVec, null);
});

test('embFit faz candidato alinhado ao userVec pontuar mais', () => {
  const profile = { genres: {}, languages: {}, decades: {}, keywords: {} };
  const ctx = { profile, mood: profile, negative: {}, catalogId: 'discovery', userVec: [1, 0, 0] };
  const base = {
    genre_ids: [], original_language: 'en', year: 2014,
    vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }],
  };

  const aligned = scoreCandidate({ ...base, _vec: [1, 0, 0] }, ctx);
  const misaligned = scoreCandidate({ ...base, _vec: [0, 1, 0] }, ctx);
  assert.ok(aligned > misaligned);

  // sem userVec, o _vec nao influencia o score
  const noVecCtx = { profile, mood: profile, negative: {}, catalogId: 'discovery' };
  const a = scoreCandidate({ ...base, _vec: [1, 0, 0] }, noVecCtx);
  const b = scoreCandidate({ ...base, _vec: [0, 1, 0] }, noVecCtx);
  assert.equal(a, b);
});

test('MMR empurra quase-duplicata para baixo em rankAndDiversify', () => {
  const profile = { genres: {}, languages: {}, decades: {}, keywords: {} };
  const ctx = { profile, mood: profile, negative: {}, catalogId: 'discovery', userVec: [1, 0] };
  const meta = {
    genre_ids: [18], original_language: 'en', year: 2014,
    vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }],
  };
  const cands = [
    { tmdb_id: 1, ...meta, _vec: [1, 0] },   // alinhado (A)
    { tmdb_id: 2, ...meta, _vec: [10, 1] },  // quase-duplicata de A, score quase tao alto (B)
    { tmdb_id: 3, ...meta, _vec: [0, 1] },   // diverso, score menor (C)
  ];

  // Sem MMR, B superaria C por score puro:
  assert.ok(scoreCandidate(cands[1], ctx) > scoreCandidate(cands[2], ctx));

  // Com MMR, a quase-duplicata (B) cai para o fim e o diverso (C) sobe.
  const out = rankAndDiversify(cands, ctx, { target: 3 });
  assert.deepEqual(out.map(c => c.tmdb_id), [1, 3, 2]);
});

test('buildAcceptedVector faz media dos vetores das recs aceitas', async () => {
  const db = fakeLearningDb({ accepted: [1, 2], vecs: { 'movie:1': [2, 0, 0], 'movie:2': [0, 2, 0] } });
  const v = await buildAcceptedVector('s1', 'movie', { db });
  assert.deepEqual(round(v), [1, 1, 0]);
});

test('buildRejectedVector faz media dos vetores dos sinais negativos', async () => {
  const db = fakeLearningDb({ negative: [3], vecs: { 'movie:3': [0, 0, 4] } });
  const v = await buildRejectedVector('s1', 'movie', { db });
  assert.deepEqual(round(v), [0, 0, 4]);
});

test('buildAcceptedVector retorna null sem aceitas com vetor', async () => {
  const db = fakeLearningDb({ accepted: [], vecs: {} });
  assert.equal(await buildAcceptedVector('s1', 'movie', { db }), null);
});

test('acceptedVec/rejectedVec ajustam o score (loop de aprendizado)', () => {
  const profile = { genres: {}, languages: {}, decades: {}, keywords: {} };
  const base = {
    genre_ids: [], original_language: 'en', year: 2014,
    vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }],
  };

  // Parecido com o aceito pontua MAIS.
  const ctxA = { profile, mood: profile, negative: {}, catalogId: 'discovery', acceptedVec: [1, 0, 0] };
  assert.ok(
    scoreCandidate({ ...base, _vec: [1, 0, 0] }, ctxA) > scoreCandidate({ ...base, _vec: [0, 1, 0] }, ctxA),
  );

  // Parecido com o rejeitado pontua MENOS.
  const ctxR = { profile, mood: profile, negative: {}, catalogId: 'discovery', rejectedVec: [1, 0, 0] };
  assert.ok(
    scoreCandidate({ ...base, _vec: [1, 0, 0] }, ctxR) < scoreCandidate({ ...base, _vec: [0, 1, 0] }, ctxR),
  );

  // Sem os vetores, comportamento inalterado.
  const ctx0 = { profile, mood: profile, negative: {}, catalogId: 'discovery' };
  assert.equal(
    scoreCandidate({ ...base, _vec: [1, 0, 0] }, ctx0),
    scoreCandidate({ ...base, _vec: [0, 1, 0] }, ctx0),
  );
});
