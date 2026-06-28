'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordFeedback, loadHardExcludedIds } = require('../src/feedback');

test('recordFeedback validates type, feedback, and id', async () => {
  const calls = [];
  const fakeDb = { execute: async (q) => { calls.push(q.args); return { rows: [] }; } };

  assert.deepEqual(await recordFeedback('s1', 'movie', 10, 'hide', { db: fakeDb }), { ok: true });
  assert.equal((await recordFeedback('s1', 'banana', 10, 'hide', { db: fakeDb })).ok, false);
  assert.equal((await recordFeedback('s1', 'movie', 10, 'invented', { db: fakeDb })).ok, false);
  assert.equal((await recordFeedback('s1', 'movie', 0, 'already_seen', { db: fakeDb })).ok, false);
  assert.equal(calls.length, 1);
});

test('loadHardExcludedIds returns ids with hard-exclusion feedback', async () => {
  const fakeDb = { execute: async () => ({ rows: [{ tmdb_id: 7 }, { tmdb_id: 8 }] }) };
  const ids = await loadHardExcludedIds('s1', 'movie', { db: fakeDb });
  assert.ok(ids.has(7));
  assert.ok(ids.has(8));
});

test('loadHardExcludedIds degrades to an empty Set on db errors', async () => {
  const fakeDb = { execute: async () => { throw new Error('boom'); } };
  const ids = await loadHardExcludedIds('s1', 'movie', { db: fakeDb });
  assert.equal(ids.size, 0);
});
