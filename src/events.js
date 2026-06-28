const taste = require('./taste');

function buildWatchedSets(watchedMovies, watchedShows) {
  return {
    movie: new Set((watchedMovies || []).map(item => item.movie?.ids?.tmdb).filter(Boolean)),
    series: new Set((watchedShows || []).map(item => item.show?.ids?.tmdb).filter(Boolean)),
  };
}

function mediaKey(type) {
  return type === 'movie' ? 'movie' : 'show';
}

function daysSince(dateString, now = Date.now()) {
  if (!dateString) return 365;
  const time = new Date(dateString).getTime();
  if (!time) return 365;
  return Math.max(0, (now - time) / 86400000);
}

function decadeOfYear(year) {
  return year ? Math.floor(Number(year) / 10) * 10 : 0;
}

function eventFromMedia(media, type, weight, occurredAt) {
  const tmdbId = media?.ids?.tmdb;
  if (!tmdbId) return null;
  return {
    tmdbId,
    type,
    title: media.title || media.name || '',
    weight,
    occurredAt,
    genres: taste.normalizeGenreIds(media.genres || []),
    keywords: [],
    people: [],
    language: media.language || '',
    decade: decadeOfYear(media.year),
    runtime: media.runtime || 0,
  };
}

function eventsFromTrakt(watched, type, now = Date.now()) {
  const key = mediaKey(type);
  const events = [];

  for (const item of watched || []) {
    const media = item[key];
    const lastWatched = item.last_watched_at ? new Date(item.last_watched_at).getTime() : 0;
    const weight = taste.eventWeight({
      plays: item.plays || 1,
      daysSince: daysSince(item.last_watched_at, now),
      completion: 1,
      source: 'watched',
      type,
    });
    const event = eventFromMedia(media, type, weight, lastWatched);
    if (event) {
      event.plays = item.plays || 1;
      event.lastWatchedAt = item.last_watched_at || '';
      events.push(event);
    }
  }

  return events.sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0));
}

function negativeEventsFromTrakt(playback, type) {
  const events = [];

  for (const item of playback || []) {
    const progress = Number(item.progress || 0);
    if (progress <= 0 || progress > 20) continue;
    const media = type === 'movie' ? item.movie : (item.show || item.episode?.show);
    const event = eventFromMedia(media, type, 1, item.paused_at ? new Date(item.paused_at).getTime() : 0);
    if (event) events.push(event);
  }

  return events;
}

// Limiar de progresso (playback) acima do qual, mesmo sem scrobble, o título conta
// como POSITIVO — "assistiu quase tudo, claramente curtiu". Abaixo de 20% já é
// abandono (negativo); a faixa 20-70% fica neutra (sinal ambíguo).
const POSITIVE_PROGRESS_MIN = 70;

// Sinais positivos vindos do PLAYBACK (não só do watched/scrobble): itens com
// progress >= 70% que ainda não estão no watchedSet (evita duplicar com o scrobble).
// O peso escala pelo completion real (progress/100), recompensando 95% > 70%.
function positiveEventsFromPlayback(playback, type, watchedSet, now = Date.now()) {
  const events = [];

  for (const item of playback || []) {
    const progress = Number(item.progress || 0);
    if (progress < POSITIVE_PROGRESS_MIN) continue;
    const media = type === 'movie' ? item.movie : (item.show || item.episode?.show);
    const tmdbId = media?.ids?.tmdb;
    if (!tmdbId) continue;
    if (watchedSet && watchedSet.has(tmdbId)) continue; // já scrobblado → não duplica

    const completion = Math.min(progress / 100, 1);
    const weight = taste.eventWeight({
      plays: 1,
      daysSince: daysSince(item.paused_at, now),
      completion,
      source: 'watched',
      type,
    });
    const event = eventFromMedia(media, type, weight, item.paused_at ? new Date(item.paused_at).getTime() : 0);
    if (event) {
      event.plays = 1;
      event.lastWatchedAt = item.paused_at || '';
      events.push(event);
    }
  }

  return events;
}

// Enriquece eventos com keywords/people/genres do media_cache (mutação in-place).
// Watched do Trakt traz gênero/idioma/década mas NÃO keywords/pessoas; ratings IMDb
// nem gênero têm. Sem isso, profile.keywords e profile.people ficam vazios e o gosto
// por tema/autor só vive (vagamente) no embedding. Degrada: sem cache → inalterado.
async function enrichEventsFromCache(events, type, deps = {}) {
  const list = (events || []).filter(event => event && event.tmdbId);
  if (!list.length) return events;
  const mediaCache = deps.mediaCache || require('./mediaCache');
  const ids = list.map(event => Number(event.tmdbId)).filter(Boolean);

  let cacheMap;
  try {
    cacheMap = await mediaCache.readCachedMedia(type, ids, deps);
  } catch {
    return events;
  }
  if (!cacheMap || !cacheMap.size) return events;

  for (const event of list) {
    const payload = cacheMap.get(Number(event.tmdbId));
    if (!payload) continue;
    if ((!event.genres || !event.genres.length) && payload.genres?.length) {
      event.genres = taste.normalizeGenreIds(payload.genres);
    }
    if (!event.keywords || !event.keywords.length) {
      event.keywords = (payload.keywords || []).map(k => k.name || k).filter(Boolean);
    }
    if (!event.people || !event.people.length) {
      const directors = (payload.directors || []).map(p => p.name || p).filter(Boolean);
      const cast = (payload.cast || []).slice(0, 5).map(p => p.name || p).filter(Boolean);
      event.people = [...directors, ...cast];
    }
  }
  return events;
}

module.exports = {
  buildWatchedSets,
  eventsFromTrakt,
  negativeEventsFromTrakt,
  positiveEventsFromPlayback,
  enrichEventsFromCache,
  daysSince,
};
