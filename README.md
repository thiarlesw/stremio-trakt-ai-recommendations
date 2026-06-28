# Reverb

AI recommendations that echo your taste.

Reverb is a self-hosted recommendation addon for Stremio-compatible clients, including Nuvio. It connects to your Trakt account, learns from what you actually watch, builds personalized movie and series catalogs in the background, and serves those catalogs through the Stremio addon protocol.

Reverb does **not** provide streams. It is a recommendation layer. You still need your own Stremio/Nuvio stream addons or media setup.

## Why Reverb Exists

Most recommendation addons are either static lists, TMDB similarity wrappers, or LLM prompts that can hallucinate titles. Reverb takes a different path:

- Trakt is treated as a passive behavior sensor: watched history, rewatching, playback progress, recency, and negatives.
- TMDB is used for grounding: every recommendation must resolve to real metadata and a real IMDb id.
- AI curates from a candidate set instead of inventing the catalog from scratch.
- The builder precomputes catalogs so Stremio/Nuvio only reads cached results.
- The ranking engine combines deterministic scoring, semantic retrieval, source evidence, memory, diversity, and AI explanations.

The goal is not just “similar titles”. The goal is the feeling of: “how did it know I would like this?”

## What It Builds

Reverb exposes six catalogs:

| Catalog | Type | Intent |
| --- | --- | --- |
| `Watch Next` | movie, series | High-confidence recommendations for what you are likely to watch soon. |
| `Beyond Your Bubble` | movie, series | Adjacent discoveries with the same emotional core in a different package. |
| `New For You` | movie, series | Recent releases filtered through your taste profile. |

Each catalog is built separately for movies and series. The internal scoring weights differ by catalog intent.

## How It Works

```txt
Trakt signals
  -> taste profile + current mood + negative profile
  -> candidate generation from multiple sources
  -> deterministic scoring + diversity
  -> AI curation and explanations
  -> cached Stremio catalogs
```

### 1. Taste Signals

Reverb reads Trakt watched and playback data and turns it into weighted events:

- Recent watches count more than old watches.
- Rewatches count as stronger positive signals.
- Series depth matters: a long binge says more than one episode.
- High playback progress can become a positive signal even before a scrobble.
- Very low playback progress can become a weak negative signal.
- Imported IMDb ratings and manual cold-start seeds can enrich the profile.

The profile tracks genres, languages, decades, keywords, people, runtime, top seeds, and genre aversions.

### 2. Candidate Generation

Reverb uses a multi-source candidate pool:

- TMDB discover by genre, keyword, language, date, and quality filters.
- TMDB recommendations and similar titles from strong seeds.
- Trakt related titles, cached by Trakt item id.
- Semantic neighbors from embeddings when configured.
- FTS5 lexical retrieval from cached title, overview, and keyword text.
- AI-generated “essence bridge” titles, grounded back through TMDB search.
- Trending fallback for cold-start or sparse profiles.

No single source owns the catalog. Sources corroborate each other and carry different weights by catalog.

### 3. Ranking

The ranker combines:

- Profile fit: genre, language, decade, keywords, and people.
- Current mood fit for `Watch Next`.
- Novelty fit for `Beyond Your Bubble`.
- Recency fit for `New For You`.
- Bayesian quality so long-tail gems can beat mediocre popular titles.
- Source evidence from recommendations, similar, discover, AI, embeddings, FTS, Trakt related, and trending.
- Accepted/rejected vectors when embeddings are available.
- Negative profile and genre aversion penalties.
- Recommendation memory to reduce stale repetition.

After scoring, Reverb diversifies the list with classic caps or vector MMR so a catalog does not collapse into near-duplicates.

### 4. AI Curation

The LLM does not freewheel. It receives a numbered candidate list and must choose valid ids from that list.

The AI curator:

- selects final picks from already-grounded candidates;
- writes short “why” explanations;
- anchors explanations in real titles from the user history when possible;
- is retried on malformed output;
- falls back to deterministic ranked results if the provider fails.

For the full Reverb experience, an OpenAI-compatible chat completions endpoint is required.

### 5. Cached Serving

Reverb runs the expensive work in a builder process. The HTTP addon routes only serve cached catalog rows from libSQL/Turso.

This keeps Stremio/Nuvio responses fast and avoids calling Trakt, TMDB, embeddings, or the LLM from the catalog endpoint.

## Features

- Stremio addon manifest and catalog endpoints.
- Session-scoped manifest URLs: `/s/:session/manifest.json`.
- Trakt device OAuth setup page at `/configure`.
- Background build after Trakt authorization.
- Stable Trakt identity reuse when the same account reconnects.
- Movie and series catalogs.
- TMDB grounding and metadata enrichment.
- OpenAI-compatible LLM curation.
- Optional OpenAI-compatible embeddings.
- FTS5 lexical retrieval with graceful fallback.
- Recommendation memory and anti-repetition.
- Explicit feedback API with hard exclusion for `hide` and `already_seen`.
- IMDb ratings import.
- Cold-start seed import.
- Offline evaluation script for retrieval metrics.
- Docker and local Node.js workflows.

## Requirements

- Node.js 20+ or Docker
- Trakt OAuth application
- TMDB API key
- Turso/libSQL database
- OpenAI-compatible chat completions endpoint
- Optional OpenAI-compatible embeddings endpoint

## Quick Start With Docker Compose

```bash
cp .env.example .env
```

Edit `.env`, then run:

```bash
docker compose up -d --build
```

Open:

```txt
http://localhost:3000/configure
```

Connect Trakt and copy the generated manifest URL into Nuvio or Stremio.

## Local Development

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

Open `http://localhost:3000/configure`.

## Configuration

Required values for the full Reverb experience:

| Variable | Description |
| --- | --- |
| `TRAKT_CLIENT_ID` | Trakt OAuth application client ID |
| `TRAKT_CLIENT_SECRET` | Trakt OAuth application client secret |
| `TMDB_API_KEY` | TMDB API key |
| `TURSO_URL` | libSQL/Turso database URL |
| `TURSO_TOKEN` | libSQL/Turso auth token |
| `AI_BASE_URL` | OpenAI-compatible chat completions base URL |
| `AI_API_KEY` | API key for the chat completions provider |
| `AI_MODEL` | Chat model name |
| `ADDON_URL` | Public base URL of this addon |

Optional values:

| Variable | Description |
| --- | --- |
| `AI_CURATOR_TIMEOUT_MS` | AI curation timeout in milliseconds, defaults to `120000` |
| `EMBED_BASE_URL` | OpenAI-compatible embeddings base URL |
| `EMBED_API_KEY` | API key for the embeddings provider |
| `EMBED_MODEL` | Embedding model name |
| `TMDB_LANGUAGE` | TMDB response language, defaults to `en-US` |
| `PORT` | HTTP port, defaults to `3000` |

## Public URLs

| Path | Purpose |
| --- | --- |
| `/configure` | User configuration and Trakt connection page |
| `/manifest.json` | Legacy/root manifest |
| `/s/:session/manifest.json` | Session-scoped manifest URL for Nuvio/Stremio |
| `/s/:session/catalog/:type/:id.json` | Session-scoped catalog endpoint |
| `/catalog/:type/:id.json?session=...` | Legacy query-based catalog route |

## Scripts

```bash
npm test
npm run build
npm run eval -- <sessionId>
node scripts/rebuild-session.js <sessionId>
node scripts/eval-recommender.js <sessionId>
node scripts/import-imdb.js <sessionId> ratings.csv
node scripts/add-coldstart-seed.js <sessionId> movie "Drive" 2011
```

## Feedback API

Reverb includes a small feedback endpoint intended for a protected UI or automation:

```txt
POST /configure/api/feedback
```

Body:

```json
{
  "session": "session-id",
  "type": "movie",
  "tmdb_id": 123,
  "feedback": "hide"
}
```

Valid feedback values:

| Value | Effect |
| --- | --- |
| `less_like_this` | Stored for future tuning. |
| `already_seen` | Hard-excluded from future catalogs. |
| `hide` | Hard-excluded from future catalogs. |
| `too_obvious` | Stored for future tuning. |
| `too_weird` | Stored for future tuning. |

Stremio/Nuvio do not currently send this kind of feedback through the addon protocol, so this endpoint is for external controls.

## Data Model

Reverb creates and maintains tables for:

- OAuth sessions
- cached recommendations
- generated-history suppression
- builder runs and locks
- build debug payloads
- taste profiles
- user events
- recommendation memory
- explicit feedback
- TMDB media cache
- semantic embeddings
- Trakt signal cache
- Trakt related cache
- cold-start seeds
- imported user ratings
- optional FTS5 media index

Schema creation is idempotent and runs at startup.

## Security Notes

- Do not commit `.env`.
- Treat generated manifest URLs as private user URLs.
- Protect `/configure` behind your own access control if you run a shared public instance.
- This addon stores OAuth tokens and recommendation data in your configured database.
- Reverb does not proxy or provide media streams.

## Limitations

- Reverb depends on Trakt data quality. If Trakt is empty or stale, recommendations will be weaker.
- Stremio/Nuvio do not send player feedback directly to this addon; Reverb infers behavior through Trakt and optional feedback APIs.
- The AI curator depends on an OpenAI-compatible provider and may fall back to deterministic ordering on errors.
- Embedding search is currently implemented with cached vectors and in-process cosine scoring, which is fine for small/self-hosted catalogs but not a large public multi-tenant service.
- FTS5 support depends on the libSQL build. If unavailable, lexical retrieval silently degrades.

## Roadmap

- Admin `/setup` wizard for non-technical self-hosters.
- First-class feedback controls in the configure UI.
- Better Stremio/Nuvio pagination with `skip` extras.
- Native Turso/libSQL vector search when available.
- More explicit offline quality dashboards.
- Optional provider/region filters for availability-aware recommendations.
- Dynamic shelf naming and more catalog intents.

## License

MIT
