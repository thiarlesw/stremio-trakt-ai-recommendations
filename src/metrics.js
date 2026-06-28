'use strict';

function hitAtK(rankedIds, relevantSet, k) {
  const set = relevantSet instanceof Set ? relevantSet : new Set(relevantSet);
  return rankedIds.slice(0, k).some(id => set.has(id)) ? 1 : 0;
}

function recallAtK(rankedIds, relevantSet, k) {
  const set = relevantSet instanceof Set ? relevantSet : new Set(relevantSet);
  if (!set.size) return 0;
  let hits = 0;
  for (const id of rankedIds.slice(0, k)) if (set.has(id)) hits += 1;
  return hits / set.size;
}

function precisionAtK(rankedIds, relevantSet, k) {
  const set = relevantSet instanceof Set ? relevantSet : new Set(relevantSet);
  const top = rankedIds.slice(0, k);
  if (!top.length) return 0;
  let hits = 0;
  for (const id of top) if (set.has(id)) hits += 1;
  return hits / top.length;
}

function reciprocalRank(rankedIds, relevantSet) {
  const set = relevantSet instanceof Set ? relevantSet : new Set(relevantSet);
  for (let i = 0; i < rankedIds.length; i++) {
    if (set.has(rankedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAtK(rankedIds, relevantSet, k) {
  const set = relevantSet instanceof Set ? relevantSet : new Set(relevantSet);
  let dcg = 0;
  const top = rankedIds.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if (set.has(top[i])) dcg += 1 / Math.log2(i + 2);
  }
  const ideal = Math.min(set.size, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

function intraListDiversity(vectors, cosine) {
  const vecs = (vectors || []).filter(v => Array.isArray(v) && v.length);
  if (vecs.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      sum += cosine(vecs[i], vecs[j]);
      pairs += 1;
    }
  }
  return pairs ? 1 - sum / pairs : 0;
}

function novelty(popularities) {
  const ps = (popularities || []).filter(p => Number.isFinite(p) && p > 0);
  if (!ps.length) return 0;
  let sum = 0;
  for (const p of ps) sum += -Math.log2(Math.min(1, Math.max(1e-6, p)));
  return sum / ps.length;
}

function coverage(recommendedIds, catalogSize) {
  if (!catalogSize) return 0;
  return new Set(recommendedIds).size / catalogSize;
}

function aggregate(cases, k) {
  const list = cases || [];
  if (!list.length) return { n: 0, hitAtK: 0, recallAtK: 0, precisionAtK: 0, mrr: 0, ndcgAtK: 0 };
  let hit = 0;
  let rec = 0;
  let prec = 0;
  let mrr = 0;
  let ndcg = 0;
  for (const c of list) {
    hit += hitAtK(c.rankedIds, c.relevantSet, k);
    rec += recallAtK(c.rankedIds, c.relevantSet, k);
    prec += precisionAtK(c.rankedIds, c.relevantSet, k);
    mrr += reciprocalRank(c.rankedIds, c.relevantSet);
    ndcg += ndcgAtK(c.rankedIds, c.relevantSet, k);
  }
  const n = list.length;
  return { n, hitAtK: hit / n, recallAtK: rec / n, precisionAtK: prec / n, mrr: mrr / n, ndcgAtK: ndcg / n };
}

module.exports = {
  hitAtK,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  intraListDiversity,
  novelty,
  coverage,
  aggregate,
};
