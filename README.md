# Reverb

AI recommendations that echo your taste.

Reverb does not provide streams. It builds personalized movie and series catalogs from your Trakt history, enriches candidates with TMDB metadata, uses an OpenAI-compatible LLM for AI curation, optionally adds embeddings for semantic retrieval, and serves cached catalogs through the Stremio addon protocol.

## Status

Alpha. The core pipeline is usable, but the public setup experience is still intentionally simple. A web-based `/setup` wizard is planned; today, server credentials are configured through `.env`.

## How It Works

1. The user opens `/configure` and connects Trakt through device OAuth.
2. Reverb reads Trakt watched/playback signals in the background.
3. A builder creates taste profiles, candidate pools, semantic vectors, scores, and LLM explanations.
4. Recommendations are stored in libSQL/Turso.
5. Nuvio/Stremio reads precomputed catalogs from the addon URL.

## Requirements

- Node.js 20+ or Docker
- Trakt OAuth application
- TMDB API key
- Turso/libSQL database
- OpenAI-compatible chat completions endpoint for AI curation
- Optional OpenAI-compatible embeddings endpoint for semantic retrieval

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

## Scripts

```bash
npm test
npm run build
node scripts/rebuild-session.js <sessionId>
node scripts/eval-recommender.js <sessionId>
node scripts/import-imdb.js <sessionId> ratings.csv
node scripts/add-coldstart-seed.js <sessionId> movie "Drive" 2011
```

## Security Notes

- Do not commit `.env`.
- Treat generated manifest URLs as private user URLs.
- Protect `/configure` behind your own access control if you run a shared public instance.
- This addon stores OAuth tokens and recommendation data in your configured database.

## Roadmap

- Admin `/setup` wizard for non-technical self-hosters.
- First-class feedback controls: more like this, less like this, already seen, hide.
- Better Stremio/Nuvio pagination with `skip` extras.
- Native Turso/libSQL vector search when available.
- More explicit offline quality metrics.

## License

MIT
