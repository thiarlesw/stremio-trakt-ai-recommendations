const TRAKT_BASE = 'https://api.trakt.tv';
const CLIENT_ID = process.env.TRAKT_CLIENT_ID;
const CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const UA = 'Mozilla/5.0 (compatible; Reverb/1.0)';

function headers(accessToken) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

const DEFAULT_PACE_MS = 200;
const DEFAULT_RETRIES = 2;
const realSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function backoffMs(attempt) {
  return Math.min(2000, 300 * 2 ** attempt);
}

function looksLikeHtml(text) {
  const head = String(text || '').trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<') || head.includes('<html') || head.includes('<!doctype');
}

// GET resiliente do Trakt. Detecta 403/429 e corpos HTML (Cloudflare) → backoff
// exponencial (poucas tentativas) e, se persistir, retorna { ok:false, blocked:true }
// SEM lançar (o build cai no cache). opts.{ fetchImpl, sleep, retries, paceMs } são
// injetáveis para testes (sem rede, sem espera).
async function traktFetch(url, accessToken, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const sleep = opts.sleep || realSleep;
  const retries = Number.isInteger(opts.retries) ? opts.retries : DEFAULT_RETRIES;
  const paceMs = opts.paceMs != null ? opts.paceMs : DEFAULT_PACE_MS;

  let attempt = 0;
  while (true) {
    if (paceMs) await sleep(paceMs);

    let res;
    try {
      res = await fetchImpl(url, { headers: headers(accessToken) });
    } catch {
      if (attempt >= retries) return { ok: false, status: 0, blocked: false, data: null, headers: null };
      await sleep(backoffMs(attempt++));
      continue;
    }

    const status = res.status;
    if (status === 403 || status === 429) {
      if (attempt >= retries) return { ok: false, status, blocked: true, data: null, headers: res.headers };
      await sleep(backoffMs(attempt++));
      continue;
    }
    if (!res.ok) {
      return { ok: false, status, blocked: false, data: null, headers: res.headers };
    }

    let text;
    try {
      text = await res.text();
    } catch {
      return { ok: false, status, blocked: false, data: null, headers: res.headers };
    }
    if (looksLikeHtml(text)) {
      if (attempt >= retries) return { ok: false, status, blocked: true, data: null, headers: res.headers };
      await sleep(backoffMs(attempt++));
      continue;
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (attempt >= retries) return { ok: false, status, blocked: true, data: null, headers: res.headers };
        await sleep(backoffMs(attempt++));
        continue;
      }
    }
    return { ok: true, status, blocked: false, data, headers: res.headers };
  }
}

async function initiateDeviceAuth() {
  const res = await fetch(`${TRAKT_BASE}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  return res.json();
  // { device_code, user_code, verification_url, expires_in, interval }
}

async function pollDeviceToken(deviceCode) {
  const res = await fetch(`${TRAKT_BASE}/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      code: deviceCode,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (res.status === 200) return res.json(); // { access_token, refresh_token, expires_in, created_at }
  if (res.status === 400) return null;       // ainda pendente
  throw new Error(`poll:${res.status}`);
}

async function refreshAccessToken(refreshTok) {
  const res = await fetch(`${TRAKT_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      refresh_token: refreshTok,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  return res.json();
}

async function getHistory(accessToken, type, limit = 30, opts = {}) {
  const endpoint = type === 'movie' ? 'movies' : 'episodes';
  return pagedGet(accessToken, `/sync/history/${endpoint}`, { limit: Math.min(limit, 100), extended: 'full' }, Math.ceil(limit / 100) || 1, opts);
}

async function getRatings(accessToken, type, opts = {}) {
  const endpoint = type === 'movie' ? 'movies' : 'shows';
  const { ok, data } = await traktFetch(`${TRAKT_BASE}/sync/ratings/${endpoint}`, accessToken, opts);
  return ok && Array.isArray(data) ? data : [];
}

// Retorna todos os títulos já assistidos (para exclusão do pool de candidatos)
async function getWatched(accessToken, type, opts = {}) {
  const endpoint = type === 'movie' ? 'movies' : 'shows';
  return pagedGet(accessToken, `/sync/watched/${endpoint}`, { limit: 100, extended: 'full' }, 50, opts);
}

async function getWatchlist(accessToken, type, opts = {}) {
  const endpoint = type === 'movie' ? 'movies' : 'shows';
  return pagedGet(accessToken, `/sync/watchlist/${endpoint}`, { limit: 100, extended: 'full' }, 20, opts);
}

async function getPlayback(accessToken, type, opts = {}) {
  const endpoint = type === 'movie' ? 'movies' : 'episodes';
  return pagedGet(accessToken, `/sync/playback/${endpoint}`, { limit: 100, extended: 'full' }, 5, opts);
}

async function getHidden(accessToken, type, opts = {}) {
  const traktType = type === 'movie' ? 'movie' : 'show';
  return pagedGet(accessToken, '/users/hidden/recommendations', { type: traktType, limit: 100, extended: 'full' }, 5, opts);
}

// /related é o CF item-item do Trakt: vizinhos de um título. Endpoint público
// (sem accessToken). Retorna [] em bloqueio/erro (via wrapper resiliente).
async function getRelated(type, traktId, opts = {}) {
  if (!traktId) return [];
  const endpoint = type === 'movie' ? 'movies' : 'shows';
  const url = new URL(`${TRAKT_BASE}/${endpoint}/${traktId}/related`);
  url.searchParams.set('limit', String(opts.limit || 10));
  url.searchParams.set('extended', 'full');
  const { ok, data } = await traktFetch(url.toString(), null, opts);
  return ok && Array.isArray(data) ? data : [];
}

async function pagedGet(accessToken, path, params = {}, maxPages = 10, opts = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${TRAKT_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('page', String(page));
    const { ok, data, headers: resHeaders } = await traktFetch(url.toString(), accessToken, opts);
    if (!ok || !Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    const pageCount = parseInt((resHeaders && resHeaders.get && resHeaders.get('x-pagination-page-count')) || '1', 10);
    if (page >= pageCount) break;
  }
  return all;
}

// /sync/last_activities: timestamps da última atividade por categoria. UMA chamada
// leve — usada pelo cron para decidir se vale re-gerar (pula se nada novo desde o build).
// Retorna o objeto cru do Trakt ou null (bloqueio/erro), via wrapper resiliente.
async function getLastActivities(accessToken, opts = {}) {
  const { ok, data } = await traktFetch(`${TRAKT_BASE}/sync/last_activities`, accessToken, opts);
  return ok && data ? data : null;
}

// Id estável da conta Trakt (não muda entre logins) — usado como identidade da sessão.
async function getUserId(accessToken, opts = {}) {
  const { ok, data } = await traktFetch(`${TRAKT_BASE}/users/settings`, accessToken, opts);
  if (!ok) return null;
  return data?.user?.ids?.uuid || data?.user?.ids?.slug || null;
}

module.exports = {
  initiateDeviceAuth,
  pollDeviceToken,
  refreshAccessToken,
  getHistory,
  getRatings,
  getWatched,
  getWatchlist,
  getPlayback,
  getHidden,
  getRelated,
  getLastActivities,
  getUserId,
  pagedGet,
  traktFetch,
};
