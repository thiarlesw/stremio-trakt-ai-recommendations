const { test } = require('node:test');
const assert = require('node:assert/strict');
const trakt = require('../src/trakt');

// Resposta fake estilo fetch (status/ok/text/headers). SEM rede.
function fakeRes({ status = 200, ok, body = '', pageCount } = {}) {
  return {
    status,
    ok: ok != null ? ok : (status >= 200 && status < 300),
    text: async () => body,
    headers: {
      get: (key) => (key === 'x-pagination-page-count' && pageCount != null ? String(pageCount) : null),
    },
  };
}

const noWait = { sleep: async () => {}, paceMs: 0 };

test('traktFetch: 403 (Cloudflare) -> blocked sem throw', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return fakeRes({ status: 403, ok: false }); };
  const out = await trakt.traktFetch('http://x', null, { fetchImpl, retries: 1, ...noWait });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  assert.equal(out.data, null);
  assert.ok(calls >= 1);
});

test('traktFetch: corpo HTML (não-JSON) -> blocked sem throw', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, ok: true, body: '<!DOCTYPE html><html><body>attention required</body></html>' });
  const out = await trakt.traktFetch('http://x', null, { fetchImpl, retries: 1, ...noWait });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, true);
  assert.equal(out.data, null);
});

test('traktFetch: sucesso devolve JSON parseado', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, ok: true, body: JSON.stringify([{ id: 1 }]) });
  const out = await trakt.traktFetch('http://x', null, { fetchImpl, retries: 0, ...noWait });
  assert.equal(out.ok, true);
  assert.equal(out.blocked, false);
  assert.deepEqual(out.data, [{ id: 1 }]);
});

test('getRelated: sucesso mapeia array; bloqueio e sem id -> []', async () => {
  const okFetch = async () => fakeRes({
    status: 200, ok: true,
    body: JSON.stringify([{ title: 'X', ids: { trakt: 9, tmdb: 99 } }]),
  });
  const related = await trakt.getRelated('movie', 5, { fetchImpl: okFetch, retries: 0, ...noWait });
  assert.equal(related.length, 1);
  assert.equal(related[0].ids.tmdb, 99);

  const blockedFetch = async () => fakeRes({ status: 403, ok: false });
  const none = await trakt.getRelated('movie', 5, { fetchImpl: blockedFetch, retries: 1, ...noWait });
  assert.deepEqual(none, []);

  const noId = await trakt.getRelated('movie', null, { fetchImpl: okFetch, retries: 0, ...noWait });
  assert.deepEqual(noId, []);
});
