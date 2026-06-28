const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hitAtK,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  intraListDiversity,
  novelty,
  coverage,
  aggregate,
} = require('../src/metrics');

test('ranking metrics handle hits inside and outside K', () => {
  const ranked = [10, 20, 30, 40];
  const relevant = new Set([30, 50]);
  assert.equal(hitAtK(ranked, relevant, 3), 1);
  assert.equal(hitAtK(ranked, [99], 5), 0);
  assert.equal(recallAtK(ranked, relevant, 3), 0.5);
  assert.equal(precisionAtK(ranked, relevant, 3), 1 / 3);
});

test('reciprocalRank and ndcgAtK score ordered relevance', () => {
  assert.equal(reciprocalRank([10, 20, 30], [20]), 0.5);
  assert.equal(reciprocalRank([10, 20, 30], [99]), 0);
  assert.ok(ndcgAtK([10, 20, 30], [20], 3) > 0);
  assert.equal(ndcgAtK([10, 20, 30], [], 3), 0);
});

test('diversity, novelty, coverage, and aggregate are defensive', () => {
  const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  assert.equal(intraListDiversity([[1, 0], [0, 1]], cosine), 1);
  assert.equal(intraListDiversity([[1, 0]], cosine), 0);
  assert.ok(novelty([0.5, 0.25]) > 0);
  assert.equal(coverage([1, 1, 2], 10), 0.2);

  const out = aggregate([
    { rankedIds: [1, 2, 3], relevantSet: new Set([2]) },
    { rankedIds: [3, 4, 5], relevantSet: new Set([5]) },
  ], 3);
  assert.equal(out.n, 2);
  assert.equal(out.hitAtK, 1);
});
