const GENRE_BY_SLUG = {
  action: 28,
  adventure: 12,
  animation: 16,
  anime: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  horror: 27,
  music: 10402,
  mystery: 9648,
  romance: 10749,
  'science-fiction': 878,
  'sci-fi': 878,
  'sci-fi-fantasy': 10765,
  'science-fiction-fantasy': 10765,
  thriller: 53,
  war: 10752,
  western: 37,
  'action-adventure': 10759,
  kids: 10762,
  children: 10762,
  reality: 10764,
  'war-politics': 10768,
};

function normalizeGenreIds(genres) {
  const ids = [];
  for (const genre of genres || []) {
    if (typeof genre === 'number') {
      ids.push(genre);
      continue;
    }
    const key = String(genre)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const id = GENRE_BY_SLUG[key];
    if (id) ids.push(id);
  }
  return Array.from(new Set(ids));
}

// Genres where absence from a sufficiently large history is a real aversion signal.
// horror, animation/anime(16), kids(10762), family(10751), documentary(99),
// reality(10764), music(10402), western(37).
const AVERSION_CANDIDATES = [27, 16, 10762, 10751, 99, 10764, 10402, 37];
const AVERSION_SHARE_EPSILON = 0.02;
const AVERSION_CONFIDENCE_MIN = 0.35;

function eventWeight({ plays = 1, daysSince = 365, completion = 1, rating = null, source = 'watched', type = 'movie' }) {
  const recency = Math.max(0, 1 - daysSince / 365);
  // Profundidade de engajamento:
  //  - filmes: revisões (rewatch), cap 5 — comportamento original preservado.
  //  - séries: nº de episódios assistidos (plays), em curva log limitada — maratonar
  //    conta mais que ver 1 ep, sem explodir o peso (1ep:1.0 · 8ep:2.5 · 64ep:4.0).
  const n = Math.max(plays || 1, 1);
  const depth = type === 'series'
    ? 1 + 0.5 * Math.log2(Math.min(n, 64))
    : 1 + 0.6 * (Math.min(n, 5) - 1);
  // completion (0..1): quanto do título foi assistido. Scrobble = 1; playback alto < 1.
  let weight = (0.5 + 0.5 * completion) * (1 + recency) * depth;

  if (source === 'watchlist') {
    weight = 0.45 + recency * 0.45;
  }

  if (typeof rating === 'number') {
    if (rating >= 9) weight += 5;
    else if (rating >= 7) weight += 3;
    else if (rating <= 5) weight -= 5;
  }

  return Math.max(0, weight);
}

function accumulate(map, key, weight) {
  if (key === undefined || key === null || key === '') return;
  map[key] = (map[key] || 0) + weight;
}

function normalizeMap(map) {
  const values = Object.values(map);
  if (!values.length) return {};
  const max = Math.max(...values, 1e-9);
  const out = {};
  for (const [key, value] of Object.entries(map)) out[key] = value / max;
  return out;
}

function buildTasteProfile(events) {
  const genres = {};
  const keywords = {};
  const people = {};
  const languages = {};
  const decades = {};
  const seedAccum = {};
  let runtimeSum = 0;
  let runtimeWeight = 0;
  let positiveCount = 0;

  for (const event of events || []) {
    const weight = event.weight ?? 0;
    if (weight <= 0) continue;
    positiveCount += 1;

    for (const genre of event.genres || []) accumulate(genres, genre, weight);
    for (const keyword of event.keywords || []) accumulate(keywords, keyword, weight);
    for (const person of event.people || []) accumulate(people, person, weight);
    accumulate(languages, event.language, weight);
    accumulate(decades, event.decade, weight);

    if (event.runtime) {
      runtimeSum += event.runtime * weight;
      runtimeWeight += weight;
    }

    if (event.tmdbId) {
      const current = seedAccum[event.tmdbId] || {
        tmdbId: event.tmdbId,
        title: event.title || '',
        weight: 0,
        plays: 0,
        lastWatchedAt: '',
      };
      current.weight += weight;
      current.plays = Math.max(current.plays || 0, event.plays || 1);
      if (!current.lastWatchedAt || (event.lastWatchedAt && event.lastWatchedAt > current.lastWatchedAt)) {
        current.lastWatchedAt = event.lastWatchedAt || current.lastWatchedAt;
      }
      seedAccum[event.tmdbId] = current;
    }
  }

  const confidence = Math.min(1, positiveCount / 40);

  // Fact layer: each genre's share by sum, not by max-normalized score.
  const totalGenreWeight = Object.values(genres).reduce((sum, value) => sum + value, 0) || 1;
  const genreShare = {};
  for (const [key, value] of Object.entries(genres)) genreShare[key] = value / totalGenreWeight;

  // Aversion: genres the user practically never watches, only when confidence is
  // sufficient and absence is meaningful for that genre family.
  const averseGenres = confidence >= AVERSION_CONFIDENCE_MIN
    ? AVERSION_CANDIDATES.filter(id => (genreShare[id] || 0) < AVERSION_SHARE_EPSILON)
    : [];

  return {
    confidence,
    genres: normalizeMap(genres),
    genreShare,
    averseGenres,
    keywords: normalizeMap(keywords),
    people: normalizeMap(people),
    languages: normalizeMap(languages),
    decades: normalizeMap(decades),
    runtime: { mean: runtimeWeight ? runtimeSum / runtimeWeight : 0, std: 0 },
    topSeeds: Object.values(seedAccum).sort((a, b) => b.weight - a.weight).slice(0, 20),
  };
}

function buildCurrentMood(recentEvents) {
  return buildTasteProfile(recentEvents);
}

function buildNegativeProfile(negativeEvents) {
  const genres = {};
  const keywords = {};
  const people = {};
  const languages = {};

  for (const event of negativeEvents || []) {
    const weight = event.weight ?? 1;
    for (const genre of event.genres || []) accumulate(genres, genre, weight);
    for (const keyword of event.keywords || []) accumulate(keywords, keyword, weight);
    for (const person of event.people || []) accumulate(people, person, weight);
    accumulate(languages, event.language, weight);
  }

  return {
    genres: normalizeMap(genres),
    keywords: normalizeMap(keywords),
    people: normalizeMap(people),
    languages: normalizeMap(languages),
  };
}

module.exports = {
  eventWeight,
  buildTasteProfile,
  buildCurrentMood,
  buildNegativeProfile,
  normalizeGenreIds,
  GENRE_BY_SLUG,
};
