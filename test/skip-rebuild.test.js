'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestBehaviorActivity, needsRebuild } = require('../src/builder');

const unix = (iso) => Math.floor(Date.parse(iso) / 1000);

test('latestBehaviorActivity: pega o maior de watched/paused em movies+episodes', () => {
  const la = {
    movies: { watched_at: '2026-06-20T10:00:00Z', paused_at: '2026-06-18T10:00:00Z' },
    episodes: { watched_at: '2026-06-25T10:00:00Z', paused_at: '2026-06-10T10:00:00Z' },
  };
  assert.equal(latestBehaviorActivity(la), unix('2026-06-25T10:00:00Z'));
});

test('latestBehaviorActivity: IGNORA rated_at/watchlisted_at (só comportamento real)', () => {
  const la = {
    movies: { watched_at: '2026-06-01T00:00:00Z', rated_at: '2026-06-30T00:00:00Z', watchlisted_at: '2026-06-29T00:00:00Z' },
    episodes: {},
  };
  // só watched_at conta; rated/watchlisted (mais recentes) são ignorados
  assert.equal(latestBehaviorActivity(la), unix('2026-06-01T00:00:00Z'));
});

test('latestBehaviorActivity: 0 quando indeterminável', () => {
  assert.equal(latestBehaviorActivity(null), 0);
  assert.equal(latestBehaviorActivity({}), 0);
});

test('needsRebuild: force sempre rebuilda', () => {
  assert.equal(needsRebuild({ force: true, lastBuildAt: unix('2030-01-01T00:00:00Z'), lastActivities: {} }), true);
});

test('needsRebuild: primeiro build (sem lastBuildAt) rebuilda', () => {
  assert.equal(needsRebuild({ lastBuildAt: 0, lastActivities: { movies: { watched_at: '2020-01-01T00:00:00Z' } } }), true);
});

test('needsRebuild: atividade indeterminável → rebuilda (fail-open)', () => {
  assert.equal(needsRebuild({ lastBuildAt: unix('2026-06-01T00:00:00Z'), lastActivities: null }), true);
});

test('needsRebuild: assistiu algo novo desde o build → rebuilda', () => {
  const la = { movies: { watched_at: '2026-06-25T00:00:00Z' } };
  assert.equal(needsRebuild({ lastBuildAt: unix('2026-06-20T00:00:00Z'), lastActivities: la }), true);
});

test('needsRebuild: nada novo desde o build → PULA', () => {
  const la = { movies: { watched_at: '2026-06-15T00:00:00Z' }, episodes: { paused_at: '2026-06-10T00:00:00Z' } };
  assert.equal(needsRebuild({ lastBuildAt: unix('2026-06-20T00:00:00Z'), lastActivities: la }), false);
});

test('needsRebuild: só rated/watchlisted recente (sem watched/paused novo) → PULA', () => {
  const la = { movies: { watched_at: '2026-06-01T00:00:00Z', rated_at: '2026-06-26T00:00:00Z' } };
  assert.equal(needsRebuild({ lastBuildAt: unix('2026-06-20T00:00:00Z'), lastActivities: la }), false);
});
