const GENRE_MAP = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10768: 'War & Politics',
};

const SOUL = `You are Reverb, a film and TV curator with taste.
Do not recommend popular titles by inertia; recommend what is right for this person.
Reply with valid JSON only, starting directly with {.
Use only the numbered ids provided. Never invent titles.
Write "why" in English and anchor it in real titles from the user's history whenever possible.`;

function extractFirstJSON(text) {
  const raw = String(text || '');
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch {
          start = -1;
        }
      }
    }
  }
  return {};
}

function buildPrompt(topCandidates, { profile, type, catalogId }) {
  const numbered = topCandidates.map((candidate, index) => ({
    ...candidate,
    _idx: candidate._idx || index + 1,
  }));
  const media = type === 'movie' ? 'movies' : 'series';
  const historyLine = (profile.topSeeds || []).slice(0, 12).map(seed => {
    const plays = seed.plays && seed.plays > 1 ? ` (${seed.plays}x)` : '';
    const weight = seed.weight ? ` weight ${Number(seed.weight).toFixed(1)}` : '';
    return `${seed.title}${plays}${weight}`;
  }).join(', ');

  // Inferred profile: strong genres/themes/people beyond the seed titles.
  const topOf = (map, n) => Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  const genreLine = topOf(profile.genres, 6).map(id => GENRE_MAP[id] || id).join(', ');
  const kwLine = topOf(profile.keywords, 10).join(', ');
  const peopleLine = topOf(profile.people, 6).join(', ');
  const averseLine = (profile.averseGenres || []).map(id => GENRE_MAP[id] || id).join(', ');
  const desc = {
    'watch-next': 'what this person is most likely to watch this week',
    discovery: 'discoveries with the same emotional core in a different package',
    'new-for-you': 'recent releases that match this person\'s taste',
  }[catalogId] || catalogId;

  const lines = numbered.map(candidate => {
    const genres = (candidate.genre_ids || []).slice(0, 2).map(id => GENRE_MAP[id]).filter(Boolean).join('/');
    const sources = (candidate.sources || []).map(source => source.seed).filter(Boolean).slice(0, 2).join(', ');
    const score = candidate._score === undefined ? '' : ` | fit ${candidate._score.toFixed(2)}`;
    const directors = (candidate.directors || []).map(person => person.name).filter(Boolean).slice(0, 2).join(', ');
    const cast = (candidate.cast || []).map(person => person.name).filter(Boolean).slice(0, 3).join(', ');
    const keywords = (candidate.keywords || []).map(keyword => keyword.name || keyword).filter(Boolean).slice(0, 5).join(', ');
    const countries = (candidate.origin_country || []).slice(0, 3).join('/');
    const overview = candidate.overview ? ` | overview: ${candidate.overview.slice(0, 260)}` : '';
    return `[${candidate._idx}] "${candidate.title}" (${candidate.year || '?'}) - ${genres || '?'} | language ${candidate.original_language || '?'}${countries ? ` | country ${countries}` : ''} | rating ${candidate.vote_average || 0}${score}${sources ? ` | pulled by: ${sources}` : ''}${directors ? ` | direction/creation: ${directors}` : ''}${cast ? ` | cast: ${cast}` : ''}${keywords ? ` | keywords: ${keywords}` : ''}${overview}`;
  }).join('\n');

  return `Strong history: ${historyLine || 'no textual history'}
Inferred profile - genres: ${genreLine || '?'}; themes: ${kwLine || '?'}; people: ${peopleLine || '?'}.${averseLine ? `\nAlmost never watches: ${averseLine}. Avoid these genres.` : ''}

Candidates (${media}):
${lines}

Choose exactly 30 ids for: ${desc}.
Variety is mandatory: each pick should add something distinct; avoid more than about 3 from the same subgenre or franchise; cover different facets of this person's taste instead of repeating the same vibe.
If there are fewer than 30 candidates, choose all acceptable candidates. Do not stop at 20 if there are more good candidates.
The "why" must anchor in a REAL TITLE from the history/profile above when one fits; if none fits, explain via the person's taste (genre/theme/creator). Never anchor a title in itself.
Reply with JSON only: {"items":[{"id":N,"why":"anchored in <history title> because... (or: matches your taste for <genre/theme>)"}]}`;
}

async function curate(topCandidates, context, callAI) {
  if (!callAI || !topCandidates?.length) return [];
  const numbered = topCandidates.map((candidate, index) => ({ ...candidate, _idx: candidate._idx || index + 1 }));
  const prompt = buildPrompt(numbered, context);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callAI(SOUL, prompt);
      const items = extractFirstJSON(raw)?.items;
      if (!Array.isArray(items)) continue;
      const valid = items
        .map(item => ({ ...item, id: Number(item.id) }))
        .filter(item => Number.isInteger(item.id) && item.id >= 1 && item.id <= numbered.length && item.why?.length >= 10)
        .map(item => ({ candidate: numbered[item.id - 1], why: item.why }));
      if (valid.length) return valid;
    } catch {
      // retry once
    }
  }
  return [];
}

module.exports = { curate, extractFirstJSON, buildPrompt, GENRE_MAP, SOUL };
