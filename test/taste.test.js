const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  eventWeight,
  buildTasteProfile,
  buildNegativeProfile,
  normalizeGenreIds,
} = require('../src/taste');

test('rewatch recente pesa mais que visto único antigo', () => {
  const recenteRewatch = eventWeight({ plays: 3, daysSince: 10, completion: 1, source: 'watched' });
  const antigoUnico = eventWeight({ plays: 1, daysSince: 700, completion: 1, source: 'watched' });

  assert.ok(recenteRewatch > antigoUnico);
});

test('rating alto é bônus, mas não requisito para peso positivo', () => {
  const comNota = eventWeight({ plays: 1, daysSince: 30, completion: 1, rating: 9, source: 'rating' });
  const semNota = eventWeight({ plays: 1, daysSince: 30, completion: 1, source: 'watched' });

  assert.ok(comNota > semNota);
  assert.ok(semNota > 0);
});

test('série: maratona (mais episódios) pesa mais; filme mantém o cap original de 5', () => {
  const poucosEps = eventWeight({ plays: 1, daysSince: 10, completion: 1, source: 'watched', type: 'series' });
  const maratona = eventWeight({ plays: 40, daysSince: 10, completion: 1, source: 'watched', type: 'series' });
  assert.ok(maratona > poucosEps, 'profundidade de série conta');

  // Filmes: comportamento original preservado (cap de plays em 5).
  const filme5 = eventWeight({ plays: 5, daysSince: 10, completion: 1, source: 'watched' });
  const filme10 = eventWeight({ plays: 10, daysSince: 10, completion: 1, source: 'watched' });
  assert.equal(filme5, filme10, 'filme: plays acima de 5 não muda o peso');
});

test('completion menor reduz o peso positivo', () => {
  const cheio = eventWeight({ plays: 1, daysSince: 10, completion: 1.0, source: 'watched' });
  const parcial = eventWeight({ plays: 1, daysSince: 10, completion: 0.7, source: 'watched' });
  assert.ok(cheio > parcial, 'assistir menos pesa menos');
  assert.ok(parcial > 0);
});

test('averseGenres: marks unseen genres when there is sufficient base (high confidence)', () => {
  const events = Array.from({ length: 25 }, (_, i) => ({
    tmdbId: i + 1, title: 't' + i, weight: 2, genres: [18], keywords: [], people: [], language: 'en', decade: 2010,
  }));
  const profile = buildTasteProfile(events);
  assert.ok(profile.confidence >= 0.5);
  assert.ok(profile.averseGenres.includes(27), 'unseen horror is averse');
  assert.ok(profile.averseGenres.includes(16), 'unseen animation is averse');
  assert.ok(!profile.averseGenres.includes(18), 'the liked drama genre is not averse');
});

test('averseGenres: curated cold-start base can already trigger aversion', () => {
  const events = Array.from({ length: 15 }, (_, i) => ({
    tmdbId: i + 1, title: 's' + i, weight: 5, genres: [18, 9648], keywords: [], people: [], language: 'en', decade: 2010,
  }));
  const profile = buildTasteProfile(events);
  assert.ok(profile.confidence >= 0.35 && profile.confidence < 0.5);
  assert.ok(profile.averseGenres.includes(16), 'unseen anime/animation is averse');
});

test('averseGenres: empty when base is insufficient (low confidence)', () => {
  const events = [{ tmdbId: 1, title: 'x', weight: 2, genres: [18], keywords: [], people: [], language: 'en', decade: 2010 }];
  const profile = buildTasteProfile(events);
  assert.ok(profile.confidence < 0.5);
  assert.deepEqual(profile.averseGenres, [], 'no base, no aversion claim');
});

test('profile aggregates normalized genres, languages, decades, and topSeeds', () => {
  const events = [
    { tmdbId: 1, title: 'A', weight: 2, genres: [18], keywords: [100], people: [50], language: 'en', decade: 2010, runtime: 120 },
    { tmdbId: 2, title: 'B', weight: 1, genres: [18, 80], keywords: [101], people: [51], language: 'ko', decade: 2020, runtime: 130 },
  ];

  const p = buildTasteProfile(events);

  assert.ok(p.genres[18] >= p.genres[80]);
  assert.ok(p.genres[18] <= 1 && p.genres[18] >= 0);
  assert.equal(p.languages.en, 1);
  assert.equal(p.topSeeds[0].tmdbId, 1);
});

test('normalizeGenreIds understands common Trakt slugs and numeric IDs', () => {
  const ids = normalizeGenreIds(['drama', 'crime', 878, 'sci-fi-fantasy']);

  assert.ok(ids.includes(18));
  assert.ok(ids.includes(80));
  assert.ok(ids.includes(878));
  assert.ok(ids.includes(10765));
});

test('negative profile aggregates rejected attributes', () => {
  const p = buildNegativeProfile([
    { weight: 1, genres: [27], keywords: [666], people: [13], language: 'ja' },
  ]);

  assert.equal(p.genres[27], 1);
  assert.equal(p.languages.ja, 1);
});
