require('dotenv').config();
const express = require('express');
const path = require('path');
const { getCatalog } = require('./catalog');
const { initiateDeviceAuth, pollDeviceToken, getUserId } = require('./trakt');
const { save: saveSession } = require('./sessions');
const { recordFeedback } = require('./feedback');
const { initSchema } = require('./db');
// Development convenience: reload the builder module for on-demand builds.
const buildForSession = (...args) => {
  delete require.cache[require.resolve('./builder')];
  return require('./builder').buildForSession(...args);
};

const app = express();
const PORT = process.env.PORT || 3000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.use(express.json());
app.use('/configure', express.static(path.join(__dirname, '..', 'public')));

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const MANIFEST = {
  id: 'cc.reverb.ai',
  name: 'Reverb',
  description: 'AI recommendations that echo your Trakt taste',
  version: '2.0.0',
  resources: ['catalog'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    { type: 'movie',  id: 'watch-next',  name: 'Watch Next' },
    { type: 'series', id: 'watch-next',  name: 'Watch Next' },
    { type: 'movie',  id: 'discovery',   name: 'Beyond Your Bubble' },
    { type: 'series', id: 'discovery',   name: 'Beyond Your Bubble' },
    { type: 'movie',  id: 'new-for-you', name: 'New For You' },
    { type: 'series', id: 'new-for-you', name: 'New For You' },
  ],
  behaviorHints: { configurable: true },
};

app.get('/manifest.json', (_req, res) => res.json(MANIFEST));
app.get('/s/:session/manifest.json', (_req, res) => res.json(MANIFEST));

app.get('/s/:session/catalog/:type/:id.json', async (req, res) => {
  const { session, type, id } = req.params;
  try {
    const metas = await getCatalog(type, id, session);
    res.json({ metas });
  } catch {
    res.json({ metas: [] });
  }
});

app.get('/catalog/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  const { session } = req.query;
  try {
    const metas = await getCatalog(type, id, session);
    res.json({ metas });
  } catch {
    res.json({ metas: [] });
  }
});

async function startAuth(_req, res) {
  try {
    res.json(await initiateDeviceAuth());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function pollAuth(req, res) {
  try {
    const token = await pollDeviceToken(req.body.device_code);
    if (!token) return res.json({ pending: true });

    // Stable Trakt identity: reconnecting reuses the same session and preserves memory.
    const traktId = await getUserId(token.access_token);
    const sessionId = await saveSession(token, traktId || undefined);
    const manifestUrl = `${ADDON_URL}/s/${sessionId}/manifest.json`;

    // Build asynchronously; the first catalog may take a short while to appear.
    setImmediate(() => {
      buildForSession(sessionId).catch(err =>
        console.error(`[server] initial build ${sessionId}:`, err.message)
      );
    });

    res.json({ success: true, manifestUrl });
  } catch (err) {
    if (err.message?.startsWith('poll:4')) return res.json({ pending: true });
    res.status(500).json({ error: err.message });
  }
}

app.post('/configure/api/auth/start', startAuth);
app.post('/configure/api/auth/poll', pollAuth);

app.post('/configure/api/feedback', async (req, res) => {
  try {
    const { session, type, tmdb_id, feedback } = req.body || {};
    const result = await recordFeedback(session, type, tmdb_id, feedback);
    if (!result.ok) return res.status(400).json(result);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Reverb -> ${ADDON_URL}`));
  })
  .catch(err => {
    console.error('Schema initialization failed:', err.message);
    process.exit(1);
  });
