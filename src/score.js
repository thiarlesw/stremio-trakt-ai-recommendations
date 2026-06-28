const { cosine } = require('./embeddings');

const EMB_WEIGHT = 0.25;
const ACCEPTED_WEIGHT = 0.15;
const REJECTED_WEIGHT = 0.2;
const KEYWORD_WEIGHT = 0.12;
const PEOPLE_WEIGHT = 0.08;
const AVERSE_WEIGHT = 0.4;
const MMR_LAMBDA = 0.5;

function namesOf(list) {
  return (list || []).map(item => (item && (item.name || item)) || '').filter(Boolean);
}

function decadeOf(year) {
  return year ? Math.floor(Number(year) / 10) * 10 : 0;
}

function affinity(map = {}, keys = []) {
  if (!keys.length) return 0;
  let sum = 0;
  for (const key of keys) sum += map[key] || 0;
  return sum / keys.length;
}

const SOURCE_KIND_WEIGHT = {
  'watch-next': { recs: 1.0, similar: 0.8, trakt_related: 0.9, discover: 0.5, ai: 0.7, embedding: 0.7, fts: 0.6, cross_essence: 0.5, cross_embedding: 0.6, trending: 0.4 },
  discovery: { embedding: 1.0, cross_embedding: 0.95, ai: 0.85, fts: 0.8, cross_essence: 0.8, similar: 0.6, recs: 0.5, trakt_related: 0.7, discover: 0.45, trending: 0.3 },
  'new-for-you': { discover: 1.0, trending: 0.8, recs: 0.7, similar: 0.6, embedding: 0.6, fts: 0.55, ai: 0.5, trakt_related: 0.6, cross_essence: 0.4, cross_embedding: 0.5 },
};

function sourceEvidence(candidate, catalogId) {
  const sources = candidate.sources || [];
  if (!sources.length) return 0;
  const weights = SOURCE_KIND_WEIGHT[catalogId] || SOURCE_KIND_WEIGHT['watch-next'];
  let best = 0;
  for (const source of sources) {
    let value = weights[source.kind] != null ? weights[source.kind] : 0.4;
    if (source.seedWeight) value *= Math.min(1.4, 0.8 + 0.2 * Math.log2(1 + source.seedWeight));
    if (typeof source.sourceRank === 'number') value *= Math.max(0.6, 1 - source.sourceRank * 0.03);
    if (typeof source.similarity === 'number') value *= Math.max(0.6, Math.min(1.3, 0.6 + 0.7 * source.similarity));
    best = Math.max(best, value);
  }
  const corroboration = Math.min(0.25, (sources.length - 1) * 0.08);
  return Math.min(1, best + corroboration);
}

// Qualidade bayesiana: puxa a nota em direção a uma média global (C) com força
// proporcional a um prior (m) de votos. Resgata a joia de cauda longa (80-200 votos)
// que o voto bruto * (votos/1000) esmagava, sem inflar título obscuro de poucos votos.
const QUALITY_PRIOR_VOTES = 200;
const QUALITY_PRIOR_MEAN = 0.6;
function qualityScore(candidate) {
  const v = candidate.vote_count || 0;
  if (v <= 0) return 0;
  const R = (candidate.vote_average || 0) / 10;
  return (v / (v + QUALITY_PRIOR_VOTES)) * R + (QUALITY_PRIOR_VOTES / (v + QUALITY_PRIOR_VOTES)) * QUALITY_PRIOR_MEAN;
}

function scoreCandidate(candidate, { profile, mood, negative = {}, catalogId, userVec, acceptedVec, rejectedVec }) {
  const genreFit = affinity(profile.genres || {}, candidate.genre_ids || []);
  const moodFit = affinity(mood.genres || {}, candidate.genre_ids || []);
  const langFit = (profile.languages || {})[candidate.original_language] || 0;
  const decadeFit = (profile.decades || {})[decadeOf(candidate.year)] || 0;
  const pull = sourceEvidence(candidate, catalogId);
  const quality = qualityScore(candidate);
  const yearsAgo = candidate.year ? Math.max(0, new Date().getFullYear() - candidate.year) : 40;
  const recency = Math.max(0, 1 - yearsAgo / 30);
  const negativeFit =
    affinity(negative.genres || {}, candidate.genre_ids || []) +
    ((negative.languages || {})[candidate.original_language] || 0);

  // Tema (keywords) e autor (direção/elenco): só pesam quando o perfil os tem.
  // affinity() retorna 0 com mapa vazio → aditivo e sem regressão quando ausentes.
  const keywordFit = affinity(profile.keywords || {}, namesOf(candidate.keywords));
  const peopleFit = affinity(profile.people || {}, namesOf(candidate.people));

  // Aversão: penaliza candidato cujos gêneros a pessoa "praticamente nunca vê".
  // Proporcional à fração de gêneros aversos → pega o anime/terror solto sem punir
  // título que só tangencia o gênero. Vazio quando não há aversões (perfil raso).
  const averse = profile.averseGenres && profile.averseGenres.length ? new Set(profile.averseGenres) : null;
  const candGenres = candidate.genre_ids || [];
  const averseFraction = (averse && candGenres.length)
    ? candGenres.filter(id => averse.has(id)).length / candGenres.length
    : 0;

  const embFit = (userVec && candidate._vec) ? Math.max(0, cosine(userVec, candidate._vec)) : 0;
  // Loop de aprendizado: aproxima do que foi aceito, afasta do que foi rejeitado.
  const acceptedFit = (acceptedVec && candidate._vec) ? Math.max(0, cosine(acceptedVec, candidate._vec)) : 0;
  const rejectedFit = (rejectedVec && candidate._vec) ? Math.max(0, cosine(rejectedVec, candidate._vec)) : 0;

  // Pesos por catálogo, rebalanceados para baixo de forma proporcional ao abrir
  // espaço para o embFit (peso EMB_WEIGHT). A intenção por catálogo é preservada:
  // base é calculada como antes e depois reescalada por (total - EMB_WEIGHT) / total.
  let base;
  let total;
  if (catalogId === 'watch-next') {
    base = 0.35 * moodFit + 0.25 * genreFit + 0.15 * quality + 0.12 * recency + 0.08 * langFit + 0.25 * pull;
    total = 1.20;
  } else if (catalogId === 'discovery') {
    const novelty = Math.max(0, 1 - moodFit);
    base = 0.3 * genreFit + 0.22 * novelty + 0.2 * quality + 0.1 * decadeFit + 0.25 * pull + 0.08 * langFit;
    total = 1.15;
  } else {
    base = 0.35 * genreFit + 0.28 * recency + 0.2 * quality + 0.1 * langFit + 0.2 * pull;
    total = 1.13;
  }

  // embFit é "carved" da base via scale (peso EMB_WEIGHT). Já acceptedFit/rejectedFit
  // são sinais de aprendizado ESPARSOS (só existem com histórico aceito/rejeitado),
  // aplicados de forma ADITIVA por cima — espelhando o padrão já existente do
  // negativeFit — em vez de entrarem no rebalance da base. Assim os pesos por catálogo
  // e os testes relativos existentes permanecem inalterados quando não há esses vetores.
  const scale = (total - EMB_WEIGHT) / total;
  const score = base * scale
    + EMB_WEIGHT * embFit
    + ACCEPTED_WEIGHT * acceptedFit
    + KEYWORD_WEIGHT * keywordFit
    + PEOPLE_WEIGHT * peopleFit;
  return score - 1.2 * negativeFit - REJECTED_WEIGHT * rejectedFit - AVERSE_WEIGHT * averseFraction;
}

// Seleção diversificada clássica (sem vetores): cota de gênero/idioma + backfill.
function selectDiversified(scored, target) {
  const selected = [];
  const selectedIds = new Set();
  const genreCount = {};
  const languageCount = {};
  const primaryGenreCap = Math.max(4, Math.ceil(target / 3));

  for (const candidate of scored) {
    const genres = (candidate.genre_ids || []).length ? candidate.genre_ids : ['unknown'];
    const language = candidate.original_language || 'unknown';
    const earlySelection = selected.length < Math.floor(target * 0.8);
    if (earlySelection && genres.some(genre => (genreCount[genre] || 0) >= primaryGenreCap)) continue;
    if (earlySelection && language !== 'en' && languageCount[language] >= 4) continue;

    selected.push(candidate);
    selectedIds.add(candidate.tmdb_id);
    for (const genre of genres) genreCount[genre] = (genreCount[genre] || 0) + 1;
    languageCount[language] = (languageCount[language] || 0) + 1;
    if (selected.length >= target) return selected;
  }

  for (const candidate of scored) {
    if (selected.length >= target) break;
    if (selectedIds.has(candidate.tmdb_id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.tmdb_id);
  }

  return selected.slice(0, target);
}

// MMR guloso usando _vec: maximiza (_score - MMR_LAMBDA * max cos com já selecionados).
// Mantém a cota de gênero/idioma como teto de segurança e faz backfill no fim.
// maxCos é mantido incrementalmente (O(target * n * dim)).
function selectMMR(scored, target) {
  const primaryGenreCap = Math.max(4, Math.ceil(target / 3));
  const pool = scored.map(candidate => ({ candidate, maxCos: 0, taken: false }));

  const selected = [];
  const selectedIds = new Set();
  const genreCount = {};
  const languageCount = {};

  while (selected.length < target) {
    let best = null;
    let bestVal = -Infinity;
    for (const entry of pool) {
      if (entry.taken) continue;
      const mmr = (entry.candidate._score || 0) - MMR_LAMBDA * entry.maxCos;
      if (mmr > bestVal) {
        bestVal = mmr;
        best = entry;
      }
    }
    if (!best) break;
    best.taken = true;

    const candidate = best.candidate;
    const genres = (candidate.genre_ids || []).length ? candidate.genre_ids : ['unknown'];
    const language = candidate.original_language || 'unknown';
    const earlySelection = selected.length < Math.floor(target * 0.8);
    const overGenre = earlySelection && genres.some(genre => (genreCount[genre] || 0) >= primaryGenreCap);
    const overLang = earlySelection && language !== 'en' && languageCount[language] >= 4;
    if (overGenre || overLang) continue; // segurado para backfill

    selected.push(candidate);
    selectedIds.add(candidate.tmdb_id);
    for (const genre of genres) genreCount[genre] = (genreCount[genre] || 0) + 1;
    languageCount[language] = (languageCount[language] || 0) + 1;

    if (Array.isArray(candidate._vec) && candidate._vec.length) {
      for (const entry of pool) {
        if (entry.taken) continue;
        if (Array.isArray(entry.candidate._vec) && entry.candidate._vec.length) {
          const cos = cosine(entry.candidate._vec, candidate._vec);
          if (cos > entry.maxCos) entry.maxCos = cos;
        }
      }
    }
  }

  if (selected.length < target) {
    for (const entry of pool) {
      if (selected.length >= target) break;
      if (selectedIds.has(entry.candidate.tmdb_id)) continue;
      selected.push(entry.candidate);
      selectedIds.add(entry.candidate.tmdb_id);
    }
  }

  return selected.slice(0, target);
}

function rankAndDiversify(candidates, context, { target = 24 } = {}) {
  const scored = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    if (!candidate?.tmdb_id || seen.has(candidate.tmdb_id)) continue;
    seen.add(candidate.tmdb_id);
    scored.push({ ...candidate, _score: scoreCandidate(candidate, context) });
  }
  scored.sort((a, b) => b._score - a._score);

  const useMMR = scored.some(candidate => Array.isArray(candidate._vec) && candidate._vec.length);
  return useMMR ? selectMMR(scored, target) : selectDiversified(scored, target);
}

// MMR final sobre os refs já ESCOLHIDOS pelo GLM ({ candidate, why }). O GLM decide
// QUEM é elegível; isto só ARRUMA os `target` mais espalhados por alma (embedding),
// garantindo variedade na prateleira mesmo se o GLM agrupou. Sem _vec, mantém a ordem.
function diversifyRefs(refs, target, lambda = MMR_LAMBDA) {
  const list = (refs || []).filter(Boolean);
  if (list.length <= target) return list;
  const hasVec = list.some(ref => Array.isArray(ref.candidate?._vec) && ref.candidate._vec.length);
  if (!hasVec) return list.slice(0, target);

  const pool = list.map(ref => ({ ref, maxCos: 0, taken: false }));
  const out = [];
  while (out.length < target) {
    let best = null;
    let bestVal = -Infinity;
    for (const entry of pool) {
      if (entry.taken) continue;
      const baseScore = entry.ref.candidate._score || 0;
      const mmr = baseScore - lambda * entry.maxCos;
      if (mmr > bestVal) { bestVal = mmr; best = entry; }
    }
    if (!best) break;
    best.taken = true;
    out.push(best.ref);
    const vec = best.ref.candidate._vec;
    if (Array.isArray(vec) && vec.length) {
      for (const entry of pool) {
        if (entry.taken) continue;
        const other = entry.ref.candidate._vec;
        if (Array.isArray(other) && other.length) {
          const cos = cosine(vec, other);
          if (cos > entry.maxCos) entry.maxCos = cos;
        }
      }
    }
  }
  return out;
}

module.exports = { scoreCandidate, rankAndDiversify, diversifyRefs, decadeOf, affinity };
