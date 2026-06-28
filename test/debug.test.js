const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serializeDebugPayload } = require('../src/debug');

test('serializeDebugPayload mantém métricas do build em JSON estável', () => {
  const payload = {
    seeds: 15,
    candidates_raw: 240,
    candidates_filtered: 180,
    sources: { discover: 120, recs: 60, similar: 45, ai: 15 },
    dropped: { watched: 40, shown: 12, hidden: 8 },
    scored: 60,
    curated: 10,
    backfilled: 14,
    saved: 24,
    ai_failed: false,
  };

  const round = JSON.parse(serializeDebugPayload(payload));

  assert.equal(round.saved, 24);
  assert.equal(round.sources.ai, 15);
  assert.equal(round.ai_failed, false);
});
