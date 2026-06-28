// Camada de embeddings semânticos.
// Degradação graciosa em tudo: sem env de embedding ou em erro de rede,
// as funções retornam null/[] e o build segue normalmente.

const EMBED_TIMEOUT_MS = 30000;

function lazyDb(deps = {}) {
  return deps.db || require('./db').db;
}

function hasProvider() {
  return Boolean(process.env.EMBED_BASE_URL && process.env.EMBED_API_KEY);
}

function nameOf(entry) {
  if (entry === null || entry === undefined) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'number') return String(entry);
  return String(entry.name || entry.title || '').trim();
}

function listText(arr, limit) {
  return (Array.isArray(arr) ? arr : [])
    .slice(0, limit)
    .map(nameOf)
    .filter(Boolean)
    .join(', ');
}

// PURA: monta texto rico e estável a partir do payload de mídia.
function mediaText(media = {}) {
  const title = (media.title || media.name || '').trim();
  const year = media.year ? ` (${media.year})` : '';
  const overview = (media.overview || '').trim();

  const head = `${title}${year}.${overview ? ' ' + overview : ''}`.trim();

  const meta = [];
  const genres = listText(media.genres, 6);
  const directors = listText(media.directors, 4);
  const cast = listText(media.cast, 8);
  const keywords = listText(media.keywords, 12);
  if (genres) meta.push(`Gêneros: ${genres}`);
  if (directors) meta.push(`Direção: ${directors}`);
  if (cast) meta.push(`Elenco: ${cast}`);
  if (keywords) meta.push(`Temas(keywords): ${keywords}`);

  return [head, meta.join(' ')].filter(Boolean).join('\n').trim();
}

// PURA: cosseno entre dois vetores; 0 quando algo é inválido ou de tamanhos diferentes.
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Chama o provedor (LiteLLM/OpenAI-compatível). Retorna number[] ou null.
async function embed(text) {
  const base = process.env.EMBED_BASE_URL;
  const key = process.env.EMBED_API_KEY;
  const model = process.env.EMBED_MODEL;
  if (!base || !key) return null;

  const input = String(text || '').trim();
  if (!input) return null;

  try {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, input }),
    });
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (Array.isArray(vec) && vec.length) return vec;
    return null;
  } catch (err) {
    console.warn('[embeddings] embed falhou:', err.message);
    return null;
  }
}

async function getCachedVec(type, tmdbId, deps = {}) {
  if (!tmdbId) return null;
  const db = lazyDb(deps);
  try {
    const res = await db.execute({
      sql: 'SELECT vec FROM media_embeddings WHERE type=? AND tmdb_id=?',
      args: [type, Number(tmdbId)],
    });
    const row = res.rows?.[0];
    if (!row?.vec) return null;
    const vec = JSON.parse(row.vec);
    return Array.isArray(vec) ? vec : null;
  } catch {
    return null;
  }
}

// Batch: Map(tmdbId -> vec) somente para os ids com vetor válido em cache.
async function getCachedVecs(type, tmdbIds = [], deps = {}) {
  const out = new Map();
  const ids = Array.from(new Set((tmdbIds || []).map(Number).filter(Boolean)));
  if (!ids.length) return out;

  const db = lazyDb(deps);
  try {
    const placeholders = ids.map(() => '?').join(',');
    const res = await db.execute({
      sql: `SELECT tmdb_id, vec FROM media_embeddings WHERE type=? AND tmdb_id IN (${placeholders})`,
      args: [type, ...ids],
    });
    for (const row of res.rows || []) {
      try {
        const vec = JSON.parse(row.vec);
        if (Array.isArray(vec) && vec.length) out.set(Number(row.tmdb_id), vec);
      } catch {
        // ignora linha corrompida
      }
    }
  } catch {
    // degradação: devolve o que houver (possivelmente vazio)
  }
  return out;
}

// Retorna o vetor (do cache ou recém-gerado). Faz upsert quando gera.
async function ensureVec(type, media = {}, deps = {}) {
  const tmdbId = Number(media.tmdb_id || media.tmdbId);
  if (!tmdbId) return null;

  const db = lazyDb(deps);
  const cached = await getCachedVec(type, tmdbId, { db });
  if (cached) return cached;

  const vec = await embed(mediaText(media));
  if (!Array.isArray(vec) || !vec.length) return null;

  try {
    await db.execute({
      sql: `INSERT INTO media_embeddings (type, tmdb_id, vec, model, dim, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(type, tmdb_id)
            DO UPDATE SET vec=excluded.vec, model=excluded.model, dim=excluded.dim, updated_at=excluded.updated_at`,
      args: [
        type,
        tmdbId,
        JSON.stringify(vec),
        process.env.EMBED_MODEL || null,
        vec.length,
        Math.floor(Date.now() / 1000),
      ],
    });
  } catch {
    // falha de escrita no cache não pode quebrar o build
  }
  return vec;
}

// Média PONDERADA (por seed.weight||1) dos vetores cacheados das seeds.
// null se nenhuma seed tem vetor em cache.
async function buildUserVector(type, seeds = [], deps = {}) {
  const list = (seeds || []).filter(seed => seed && (seed.tmdbId || seed.tmdb_id));
  if (!list.length) return null;

  const db = lazyDb(deps);
  const ids = list.map(seed => Number(seed.tmdbId || seed.tmdb_id)).filter(Boolean);
  const vecs = await getCachedVecs(type, ids, { db });
  if (!vecs.size) return null;

  let sum = null;
  let totalWeight = 0;
  for (const seed of list) {
    const id = Number(seed.tmdbId || seed.tmdb_id);
    const vec = vecs.get(id);
    if (!vec) continue;
    if (!sum) sum = new Array(vec.length).fill(0);
    if (vec.length !== sum.length) continue; // ignora dimensões divergentes
    const weight = Number(seed.weight) > 0 ? Number(seed.weight) : 1;
    for (let i = 0; i < vec.length; i++) sum[i] += vec[i] * weight;
    totalWeight += weight;
  }

  if (!sum || totalWeight === 0) return null;
  return sum.map(value => value / totalWeight);
}

// Média (não ponderada) dos vetores cacheados de uma lista de ids. null se nenhum.
async function averageOfCachedVecs(type, tmdbIds = [], deps = {}) {
  const ids = Array.from(new Set((tmdbIds || []).map(Number).filter(Boolean)));
  if (!ids.length) return null;

  const vecs = await getCachedVecs(type, ids, deps);
  if (!vecs.size) return null;

  let sum = null;
  let count = 0;
  for (const vec of vecs.values()) {
    if (!sum) sum = new Array(vec.length).fill(0);
    if (vec.length !== sum.length) continue;
    for (let i = 0; i < vec.length; i++) sum[i] += vec[i];
    count += 1;
  }
  if (!sum || count === 0) return null;
  return sum.map(value => value / count);
}

// Vetor "alma do que foi aceito": média dos vetores das recomendações aceitas.
async function buildAcceptedVector(sessionId, type, deps = {}) {
  const db = lazyDb(deps);
  let ids;
  try {
    const res = await db.execute({
      sql: 'SELECT tmdb_id FROM recommendation_memory WHERE session_id=? AND type=? AND accepted_at IS NOT NULL',
      args: [sessionId, type],
    });
    ids = (res.rows || []).map(row => Number(row.tmdb_id)).filter(Boolean);
  } catch {
    return null;
  }
  return averageOfCachedVecs(type, ids, { db });
}

// Vetor "alma do que foi rejeitado": média dos vetores dos sinais negativos.
async function buildRejectedVector(sessionId, type, deps = {}) {
  const db = lazyDb(deps);
  let ids;
  try {
    const res = await db.execute({
      sql: "SELECT tmdb_id FROM user_events WHERE session_id=? AND type=? AND event_type='negative_signal'",
      args: [sessionId, type],
    });
    ids = (res.rows || []).map(row => Number(row.tmdb_id)).filter(Boolean);
  } catch {
    return null;
  }
  return averageOfCachedVecs(type, ids, { db });
}

module.exports = {
  hasProvider,
  mediaText,
  cosine,
  embed,
  getCachedVec,
  getCachedVecs,
  ensureVec,
  buildUserVector,
  averageOfCachedVecs,
  buildAcceptedVector,
  buildRejectedVector,
};
