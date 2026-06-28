'use strict';

// Utilitários de cold start e injeção de sinais externos (IMDb ratings).
// Usa carregamento preguiçoso de db (mesmo padrão de candidates.js) para que
// o módulo possa ser importado em testes sem TURSO_URL configurado.

const taste = require('./taste');

function lazyDb(deps) {
  return (deps && deps.db) || require('./db').db;
}

// Carrega cold_start_seeds para uma sessão/tipo.
async function loadColdStartSeeds(sessionId, type, deps = {}) {
  const dbi = lazyDb(deps);
  try {
    const res = await dbi.execute({
      sql: 'SELECT tmdb_id, title, weight FROM cold_start_seeds WHERE session_id=? AND type=?',
      args: [sessionId, type],
    });
    return (res.rows || []).map(row => ({
      tmdbId: Number(row.tmdb_id),
      title: row.title || '',
      weight: Number(row.weight) || 5,
    }));
  } catch {
    return [];
  }
}

// Carrega user_ratings com tmdb_id já resolvido para uma sessão/tipo.
async function loadUserRatingsForType(sessionId, type, deps = {}) {
  const dbi = lazyDb(deps);
  try {
    const res = await dbi.execute({
      sql: 'SELECT rating, rated_at, tmdb_id, title FROM user_ratings WHERE session_id=? AND type=? AND tmdb_id IS NOT NULL',
      args: [sessionId, type],
    });
    return res.rows || [];
  } catch {
    return [];
  }
}

// Converts IMDb ratings into positive/negative events for the taste profile.
// 8-10: strongly positive (taste.eventWeight), 5-7: mild (weight 1.0), 1-4: negative.
// PURE: does not access database.
function buildUserRatingEvents(rows) {
  const positiveEvents = [];
  const negativeEvents = [];
  for (const row of rows || []) {
    const tmdbId = Number(row.tmdb_id);
    if (!tmdbId) continue;
    const rating = Number(row.rating);
    if (!rating || rating < 1 || rating > 10) continue;

    const base = {
      tmdbId,
      title: row.title || '',
      genres: [],
      keywords: [],
      people: [],
      language: '',
      decade: 0,
      runtime: 0,
    };

    if (rating >= 8) {
      const weight = taste.eventWeight({ plays: 1, daysSince: 30, completion: 1, rating, source: 'rating' });
      positiveEvents.push({ ...base, weight });
    } else if (rating >= 6) {
      // 6-7: positivo fraco
      positiveEvents.push({ ...base, weight: 1.0 });
    } else if (rating === 5) {
      // 5: neutro — nem positivo nem negativo
    } else {
      // 1-4: sinal negativo forte
      negativeEvents.push({ ...base, weight: 1.0 });
    }
  }
  return { positiveEvents, negativeEvents };
}

// BuildUserVectorForSeeds commented out by builder.js:704 scope
async function injectExternalSignals(sessionId, ctx, type, deps = {}) {
  const { enrichEventsFromCache } = require('./events');
  const extraPositives = [];
  const extraNegatives = [];

  // 1. User ratings IMDb → eventos
  const userRatings = await loadUserRatingsForType(sessionId, type, deps);
  if (userRatings.length) {
    const { positiveEvents, negativeEvents } = buildUserRatingEvents(userRatings);
    extraPositives.push(...positiveEvents);
    extraNegatives.push(...negativeEvents);
  }

      // 2. Cold start seeds → high-weight synthetic events (also remodel profile,
      //    not just pull candidates). Stored for exclusion of recs and cross-type.
      const coldSeeds = await loadColdStartSeeds(sessionId, type, deps);
      ctx.coldSeeds = coldSeeds;
      ctx.coldSeedIds = new Set(coldSeeds.map(s => s.tmdbId).filter(Boolean));
  for (const seed of coldSeeds) {
    extraPositives.push({
      tmdbId: seed.tmdbId,
      title: seed.title || '',
      weight: Number(seed.weight) > 0 ? Number(seed.weight) : 5,
      genres: [], keywords: [], people: [], language: '', decade: 0, runtime: 0,
    });
  }

  // Enriches extra events (ratings + cold seeds) — keywords/people/gender from cache.
  await enrichEventsFromCache(extraPositives, type, deps);

  // 3. Rebuild do perfil sobre todos os positivos (extras primeiro → viram topSeeds).
  if (extraPositives.length) {
    const allEvents = [...extraPositives, ...ctx.events];
    ctx.events = allEvents;
    ctx.profile = taste.buildTasteProfile(allEvents);
    ctx.seeds = ctx.profile.topSeeds.map(s => ({ tmdbId: s.tmdbId, title: s.title, weight: s.weight }));
    // ctx.mood NÃO é tocado: permanece o comportamental recente de buildTypeContexts.
  }

  if (extraNegatives.length) {
    await enrichEventsFromCache(extraNegatives, type, deps);
    const allNeg = [...extraNegatives, ...ctx.negativeEvents];
    ctx.negativeEvents = allNeg;
    ctx.negative = taste.buildNegativeProfile(allNeg);
    ctx.hiddenIds = new Set(allNeg.map(e => e.tmdbId).filter(Boolean));
  }

  // 4. Garante cold seeds em ctx.seeds (puxam related/recs do TMDB), sem duplicar
  //    as que já entraram via topSeeds no rebuild acima.
  if (coldSeeds.length) {
    const present = new Set((ctx.seeds || []).map(s => s.tmdbId));
    const missing = coldSeeds.filter(s => s.tmdbId && !present.has(s.tmdbId));
    if (missing.length) ctx.seeds = [...missing, ...(ctx.seeds || [])];
  }
}

module.exports = {
  loadColdStartSeeds,
  loadUserRatingsForType,
  buildUserRatingEvents,
  injectExternalSignals,
};
