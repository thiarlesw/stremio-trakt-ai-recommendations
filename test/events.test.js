const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildWatchedSets, eventsFromTrakt, negativeEventsFromTrakt, positiveEventsFromPlayback, enrichEventsFromCache } = require('../src/events');

test('buildWatchedSets keeps movies and series in separate namespaces', () => {
  const sets = buildWatchedSets(
    [{ movie: { ids: { tmdb: 550 } } }],
    [{ show: { ids: { tmdb: 550 } } }],
  );

  assert.ok(sets.movie.has(550));
  assert.ok(sets.series.has(550));
});

test('eventsFromTrakt creates weighted events with normalized genres', () => {
  const watched = [{
    plays: 3,
    last_watched_at: '2026-06-20T00:00:00.000Z',
    movie: {
      title: 'Drive',
      year: 2011,
      runtime: 100,
      language: 'en',
      genres: ['drama', 'crime'],
      ids: { tmdb: 64690 },
    },
  }];
  const events = eventsFromTrakt(watched, 'movie', new Date('2026-06-27T00:00:00.000Z').getTime());

  const drive = events.find(event => event.tmdbId === 64690);

  assert.equal(events.length, 1);
  assert.ok(drive.weight > 0);
  assert.ok(drive.genres.includes(18));
  assert.ok(drive.genres.includes(80));
});

test('negativeEventsFromTrakt usa playback baixo como rejeição', () => {
  const playback = [{ progress: 8, movie: { title: 'Drop', genres: ['comedy'], language: 'en', ids: { tmdb: 2 } } }];

  const events = negativeEventsFromTrakt(playback, 'movie');

  assert.equal(events.length, 1);
  assert.ok(events.some(e => e.tmdbId === 2));
  assert.ok(events.some(e => e.genres.includes(35)));
});

test('positiveEventsFromPlayback: progresso alto (≥70%) vira positivo; faixa média/baixa não', () => {
  const playback = [
    { progress: 85, paused_at: '2026-06-20T00:00:00Z', movie: { title: 'Quase', genres: ['drama'], language: 'en', ids: { tmdb: 10 } } },
    { progress: 50, paused_at: '2026-06-20T00:00:00Z', movie: { title: 'Meio', ids: { tmdb: 11 } } },
    { progress: 10, paused_at: '2026-06-20T00:00:00Z', movie: { title: 'Largado', ids: { tmdb: 12 } } },
  ];
  const events = positiveEventsFromPlayback(playback, 'movie', new Set());

  assert.equal(events.length, 1, 'só o ≥70% conta como positivo');
  assert.equal(events[0].tmdbId, 10);
  assert.ok(events[0].weight > 0);
});

test('enrichEventsFromCache: fills keywords/people and genre (when empty) from cache', async () => {
  const now = Math.floor(Date.now() / 1000);
  const fakeDb = {
    execute: async () => ({
      rows: [{
        tmdb_id: 7,
        updated_at: now,
        payload: JSON.stringify({
          genres: ['Drama'],
          keywords: [{ name: 'slow burn' }, { name: 'political intrigue' }],
          directors: [{ name: 'Villeneuve' }],
          cast: [{ name: 'Gosling' }],
        }),
      }],
    }),
  };
  const events = [{ tmdbId: 7, genres: [], keywords: [], people: [] }];

  await enrichEventsFromCache(events, 'movie', { db: fakeDb });

  assert.deepEqual(events[0].keywords, ['slow burn', 'political intrigue']);
  assert.ok(events[0].people.includes('Villeneuve'));
  assert.ok(events[0].people.includes('Gosling'));
  assert.ok(events[0].genres.includes(18), 'Drama → 18');
});

test('enrichEventsFromCache: sem cache, eventos ficam inalterados', async () => {
  const fakeDb = { execute: async () => ({ rows: [] }) };
  const events = [{ tmdbId: 7, genres: [], keywords: [], people: [] }];
  await enrichEventsFromCache(events, 'movie', { db: fakeDb });
  assert.deepEqual(events[0].keywords, []);
  assert.deepEqual(events[0].people, []);
});

test('positiveEventsFromPlayback: ignora já-scrobblado (watchedSet) e usa show para série', () => {
  const playback = [
    { progress: 90, paused_at: '2026-06-20T00:00:00Z', show: { title: 'NovaSérie', ids: { tmdb: 20 } } },
    { progress: 90, paused_at: '2026-06-20T00:00:00Z', show: { title: 'JaVista', ids: { tmdb: 21 } } },
  ];
  const events = positiveEventsFromPlayback(playback, 'series', new Set([21]));

  assert.equal(events.length, 1, 'o já-scrobblado (21) não duplica');
  assert.equal(events[0].tmdbId, 20);
});
