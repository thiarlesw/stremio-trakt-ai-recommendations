require('dotenv').config();
const { initSchema } = require('../src/db');
const sessions = require('../src/sessions');
const trakt = require('../src/trakt');

(async () => {
  await initSchema();
  const ids = await sessions.listActive();
  if (!ids.length) {
    console.log('Sem sessões ativas. Conecte um Trakt primeiro.');
    return;
  }

  const session = await sessions.load(ids[0]);
  const [movies, shows, watchlistMovies, watchlistShows, playbackMovies, hiddenMovies] = await Promise.all([
    trakt.getWatched(session.access_token, 'movie'),
    trakt.getWatched(session.access_token, 'series'),
    trakt.getWatchlist(session.access_token, 'movie'),
    trakt.getWatchlist(session.access_token, 'series'),
    trakt.getPlayback(session.access_token, 'movie'),
    trakt.getHidden(session.access_token, 'movie'),
  ]);

  console.log(`watched filmes=${movies.length} séries=${shows.length}`);
  console.log(`watchlist filmes=${watchlistMovies.length} séries=${watchlistShows.length}`);
  console.log(`playback filmes=${playbackMovies.length} hidden filmes=${hiddenMovies.length}`);
  console.log('exemplo:', JSON.stringify(movies[0]?.movie?.title), movies[0]?.plays, movies[0]?.last_watched_at);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
