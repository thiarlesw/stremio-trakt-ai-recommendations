const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreCandidate, rankAndDiversify, diversifyRefs, decadeOf } = require('../src/score');

const profile = {
  genres: { 18: 1, 80: 0.5 },
  languages: { en: 1 },
  decades: { 2010: 1 },
  keywords: {},
  people: {},
  runtime: { mean: 120 },
  confidence: 0.8,
  topSeeds: [],
};

test('decadeOf calcula década por ano', () => {
  assert.equal(decadeOf(2014), 2010);
  assert.equal(decadeOf(0), 0);
});

test('candidato alinhado ao perfil pontua mais que desalinhado', () => {
  const bom = scoreCandidate({
    genre_ids: [18],
    original_language: 'en',
    year: 2014,
    vote_average: 7.8,
    vote_count: 3000,
    sources: [{ kind: 'discover' }],
  }, { profile, mood: profile, negative: {}, catalogId: 'discovery' });

  const ruim = scoreCandidate({
    genre_ids: [16],
    original_language: 'ja',
    year: 1995,
    vote_average: 7.8,
    vote_count: 3000,
    sources: [{ kind: 'discover' }],
  }, { profile, mood: profile, negative: {}, catalogId: 'discovery' });

  assert.ok(bom > ruim);
});

test('keywordFit and peopleFit boost candidates matching known themes/authors', () => {
  const richProfile = { ...profile, keywords: { 'time loop': 1, 'slow burn': 0.5 }, people: { 'Villeneuve': 1 } };
  const ctx = { profile: richProfile, mood: richProfile, negative: {}, catalogId: 'discovery' };
  const base = { genre_ids: [18], original_language: 'en', year: 2014, vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }] };

  const comTema = scoreCandidate({ ...base, keywords: [{ name: 'time loop' }], people: ['Villeneuve'] }, ctx);
  const semTema = scoreCandidate({ ...base, keywords: [{ name: 'romcom' }], people: ['Outro'] }, ctx);

  assert.ok(comTema > semTema, 'tema/autor do gosto pontua mais');
});

test('keywordFit/peopleFit não regridem quando o perfil não tem tema/autor', () => {
  const ctx = { profile, mood: profile, negative: {}, catalogId: 'discovery' };
  const base = { genre_ids: [18], original_language: 'en', year: 2014, vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }] };

  const comKw = scoreCandidate({ ...base, keywords: [{ name: 'time loop' }], people: ['X'] }, ctx);
  const semKw = scoreCandidate({ ...base }, ctx);

  assert.equal(comKw, semKw, 'sem profile.keywords/people, candidatos com tema não mudam o score');
});

test('aversion penalizes candidates from genres the user never watches', () => {
  const p = { ...profile, averseGenres: [27] };
  const ctx = { profile: p, mood: p, negative: {}, catalogId: 'discovery' };
  const base = { original_language: 'en', year: 2014, vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }] };
  const naoAverso = scoreCandidate({ ...base, genre_ids: [18] }, ctx);
  const averso = scoreCandidate({ ...base, genre_ids: [27] }, ctx);
  assert.ok(naoAverso > averso, 'averse genre scores lower');
});

test('qualidade bayesiana: joia de cauda longa supera popular mediano', () => {
  const ctx = { profile, mood: profile, negative: {}, catalogId: 'discovery' };
  const base = { genre_ids: [18], original_language: 'en', year: 2014, sources: [{ kind: 'discover' }] };
  // Antes (voto bruto * votos/1000) o popular mediano vencia; bayesiano corrige.
  const joia = scoreCandidate({ ...base, vote_average: 8.5, vote_count: 150 }, ctx);
  const popularMeh = scoreCandidate({ ...base, vote_average: 6.0, vote_count: 5000 }, ctx);
  assert.ok(joia > popularMeh, 'nota alta na cauda longa supera popular mediano');
});

test('diversifyRefs espalha por alma os escolhidos do GLM (mata o quase-gêmeo)', () => {
  const refs = [
    { candidate: { tmdb_id: 1, _score: 1.0, _vec: [1, 0, 0] }, why: 'a' },
    { candidate: { tmdb_id: 2, _score: 0.99, _vec: [0.99, 0.01, 0] }, why: 'b' }, // quase-gêmeo do 1
    { candidate: { tmdb_id: 3, _score: 0.9, _vec: [0, 1, 0] }, why: 'c' },        // distinto
  ];
  const out = diversifyRefs(refs, 2);
  const ids = out.map(ref => ref.candidate.tmdb_id);
  assert.ok(ids.includes(1) && ids.includes(3), 'melhor + distinto entram');
  assert.ok(!ids.includes(2), 'quase-gêmeo (alta similaridade) fica de fora');
});

test('perfil negativo penaliza candidato parecido com rejeição', () => {
  const ctx = { profile, mood: profile, negative: { genres: { 27: 1 } }, catalogId: 'watch-next' };
  const semNeg = scoreCandidate({ genre_ids: [18], original_language: 'en', year: 2014, vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }] }, ctx);
  const comNeg = scoreCandidate({ genre_ids: [27], original_language: 'en', year: 2014, vote_average: 7, vote_count: 1000, sources: [{ kind: 'discover' }] }, ctx);

  assert.ok(semNeg > comNeg);
});

test('rankAndDiversify respeita alvo e não repete tmdb_id', () => {
  const cands = Array.from({ length: 40 }, (_, i) => ({
    tmdb_id: i,
    title: `T${i}`,
    genre_ids: [i % 2 ? 18 : 80],
    original_language: 'en',
    year: 2010 + (i % 10),
    vote_average: 7,
    vote_count: 1000,
    sources: [{ kind: 'discover' }],
  }));

  const out = rankAndDiversify(cands, { profile, mood: profile, negative: {}, catalogId: 'discovery' }, { target: 24 });

  assert.equal(out.length, 24);
  assert.equal(new Set(out.map(c => c.tmdb_id)).size, 24);
});
