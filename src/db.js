require('dotenv').config();
const { createClient } = require('@libsql/client');

const dbUrl = process.env.TURSO_URL || 'file:reverb-local.db';

const db = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_TOKEN,
});

async function initSchema() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_in INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_build_at INTEGER,
      last_build_error TEXT,
      trakt_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS recommendations (
      session_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      type TEXT NOT NULL,
      items TEXT NOT NULL,
      built_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, catalog_id, type)
    );

    CREATE TABLE IF NOT EXISTS generated_history (
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, type, tmdb_id)
    );

    CREATE TABLE IF NOT EXISTS builder_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      recs_generated INTEGER,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS builder_locks (
      session_id TEXT PRIMARY KEY,
      locked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS build_debug (
      session_id TEXT NOT NULL,
      catalog_id TEXT NOT NULL,
      type TEXT NOT NULL,
      built_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (session_id, catalog_id, type)
    );

    CREATE TABLE IF NOT EXISTS taste_profiles (
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      built_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, type)
    );

    CREATE TABLE IF NOT EXISTS user_events (
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      title TEXT,
      occurred_at INTEGER NOT NULL,
      weight REAL NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (session_id, type, event_type, tmdb_id, occurred_at)
    );

    CREATE TABLE IF NOT EXISTS recommendation_memory (
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      first_recommended_at INTEGER NOT NULL,
      last_recommended_at INTEGER NOT NULL,
      times_recommended INTEGER NOT NULL DEFAULT 1,
      accepted_at INTEGER,
      last_catalog_id TEXT,
      sources_json TEXT,
      PRIMARY KEY (session_id, type, tmdb_id)
    );

    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      feedback TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, type, tmdb_id, feedback)
    );

    CREATE TABLE IF NOT EXISTS media_cache (
      type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (type, tmdb_id)
    );
  `);

  // Idempotent migration for existing databases: column + unique trakt_user_id index.
  await db.execute('ALTER TABLE sessions ADD COLUMN trakt_user_id TEXT').catch(() => {});
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_trakt_user ON sessions(trakt_user_id)').catch(() => {});

  await db.execute('ALTER TABLE recommendation_memory ADD COLUMN last_rank INTEGER').catch(() => {});
  await db.execute('ALTER TABLE recommendation_memory ADD COLUMN last_score REAL').catch(() => {});

  // Lexical retrieval source. If this libSQL build lacks FTS5, the CREATE fails here
  // and ftsCandidates returns [] without breaking the recommendation build.
  await db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS media_fts USING fts5(tmdb_id UNINDEXED, type UNINDEXED, text)').catch(() => {});

  // Idempotent migration: semantic embedding cache by media item.
  await db.execute(`CREATE TABLE IF NOT EXISTS media_embeddings (
      type TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      vec TEXT NOT NULL,
      model TEXT,
      dim INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (type, tmdb_id)
    )`).catch(() => {});

  // Idempotent migration: cached Trakt watched/playback signals by session.
  await db.execute(`CREATE TABLE IF NOT EXISTS trakt_cache (
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, type, kind)
    )`).catch(() => {});

  // Idempotent migration: Trakt /related cache by trakt id.
  await db.execute(`CREATE TABLE IF NOT EXISTS trakt_related_cache (
      type TEXT NOT NULL,
      trakt_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (type, trakt_id)
    )`).catch(() => {});

  // Idempotent migration: cold-start onboarding seeds by session.
  await db.execute(`CREATE TABLE IF NOT EXISTS cold_start_seeds (
      session_id TEXT NOT NULL,
      tmdb_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 5,
      title TEXT,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, tmdb_id, type)
    )`).catch(() => {});

  // Migração idempotente: notas do IMDb importadas pelo usuário.
  await db.execute(`CREATE TABLE IF NOT EXISTS user_ratings (
      session_id TEXT NOT NULL,
      imdb_id TEXT NOT NULL,
      type TEXT NOT NULL,
      rating INTEGER NOT NULL,
      rated_at INTEGER NOT NULL,
      tmdb_id INTEGER,
      title TEXT,
      PRIMARY KEY (session_id, imdb_id)
    )`).catch(() => {});
}

module.exports = { db, initSchema };
