'use strict';

require('dotenv').config();
const { initSchema, db } = require('../src/db');
const sessions = require('../src/sessions');
const embeddings = require('../src/embeddings');
const metrics = require('../src/metrics');

const HOLDOUT = 10;
const KS = [5, 10, 24];

async function watchedMostRecent(sessionId, type) {
  const res = await db.execute({
    sql: "SELECT tmdb_id, MAX(occurred_at) AS t FROM user_events WHERE session_id=? AND type=? AND event_type='positive_signal' GROUP BY tmdb_id ORDER BY t DESC",
    args: [sessionId, type],
  }).catch(() => ({ rows: [] }));
  return (res.rows || []).map(r => Number(r.tmdb_id)).filter(Boolean);
}

async function allVecs(type) {
  const res = await db.execute({ sql: 'SELECT tmdb_id, vec FROM media_embeddings WHERE type=?', args: [type] }).catch(() => ({ rows: [] }));
  const map = new Map();
  for (const r of res.rows || []) {
    try {
      const v = JSON.parse(r.vec);
      if (Array.isArray(v) && v.length) map.set(Number(r.tmdb_id), v);
    } catch {
      // ignore corrupt vectors
    }
  }
  return map;
}

async function acceptance(sessionId, type) {
  const res = await db.execute({
    sql: 'SELECT COUNT(*) AS total, SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS accepted FROM recommendation_memory WHERE session_id=? AND type=?',
    args: [sessionId, type],
  }).catch(() => ({ rows: [{ total: 0, accepted: 0 }] }));
  const row = res.rows[0] || {};
  const total = Number(row.total || 0);
  const accepted = Number(row.accepted || 0);
  return { total, accepted, rate: total ? +(accepted / total).toFixed(3) : 0 };
}

function looEmbedding(watchedWithVec, vecMap) {
  const dim = vecMap.get(watchedWithVec[0]).length;
  const total = new Array(dim).fill(0);
  for (const id of watchedWithVec) {
    const v = vecMap.get(id);
    for (let i = 0; i < dim; i++) total[i] += v[i];
  }
  const n = watchedWithVec.length;
  const watchedSet = new Set(watchedWithVec);
  const holdout = watchedWithVec.slice(0, HOLDOUT);
  const cases = [];

  for (const h of holdout) {
    const hv = vecMap.get(h);
    const uv = new Array(dim);
    for (let i = 0; i < dim; i++) uv[i] = (total[i] - hv[i]) / (n - 1);

    const scored = [];
    for (const [id, vec] of vecMap) {
      if (watchedSet.has(id) && id !== h) continue;
      scored.push([id, embeddings.cosine(uv, vec)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    cases.push({ rankedIds: scored.map(x => x[0]), relevantSet: new Set([h]) });
  }
  return cases;
}

async function evalType(sessionId, type) {
  const watched = await watchedMostRecent(sessionId, type);
  const vecMap = await allVecs(type);
  const acc = await acceptance(sessionId, type);
  const watchedWithVec = watched.filter(id => vecMap.has(id));

  if (watchedWithVec.length < HOLDOUT + 5 || vecMap.size < 30) {
    return { skipped: true, watched: watched.length, withVec: watchedWithVec.length, pool: vecMap.size, acceptance: acc };
  }

  const cases = looEmbedding(watchedWithVec, vecMap);
  const out = { watched: watched.length, withVec: watchedWithVec.length, pool: vecMap.size, holdout: cases.length, acceptance: acc, coverage: +metrics.coverage(watched, vecMap.size).toFixed(3) };
  for (const k of KS) {
    const agg = metrics.aggregate(cases, k);
    out[`hit@${k}`] = +agg.hitAtK.toFixed(3);
    out[`ndcg@${k}`] = +agg.ndcgAtK.toFixed(3);
  }
  out.mrr = +metrics.aggregate(cases, KS[KS.length - 1]).mrr.toFixed(3);
  return out;
}

(async () => {
  await initSchema();
  const arg = process.argv[2];
  const ids = arg ? [arg] : await sessions.listActive();
  if (!ids.length) { console.log('No sessions to evaluate.'); return; }

  for (const id of ids) {
    console.log(`\n=== eval ${id} ===`);
    for (const type of ['movie', 'series']) {
      const r = await evalType(id, type);
      console.log(type, JSON.stringify(r));
    }
  }
  console.log('\n[eval] done');
})().catch(err => { console.error(err); process.exit(1); });
