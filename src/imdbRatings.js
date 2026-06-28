'use strict';

const fs = require('fs');

// Mapeamento de Title Type (IMDb) para tipo interno
const TYPE_MAP = {
  Movie: 'movie',
  'TV Series': 'series',
  'TV Mini Series': 'series',
  tvSeries: 'series',
  tvMiniSeries: 'series',
};

// Parse de uma linha CSV respeitando campos entre aspas (incluindo vírgulas internas)
function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        // aspas duplas dentro de campo entre aspas → literal "
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// PURA: converte texto CSV do IMDb em array de entradas normalizadas.
// Ignora TV Episodes e outros tipos não suportados.
// Retorna [{imdbId, rating, type('movie'|'series'), year, title}]
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  // Linha 0: cabeçalho — pulamos
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    // Colunas (0-indexed): Const, Your Rating, Date Rated, Title, Original Title,
    //   URL, Title Type, IMDb Rating, Runtime (mins), Year, Genres, ...
    if (fields.length < 10) continue;

    const imdbId = (fields[0] || '').trim();
    const ratingRaw = parseInt(fields[1], 10);
    const title = (fields[3] || fields[4] || '').trim();
    const titleType = (fields[6] || '').trim();
    const year = parseInt(fields[9], 10) || 0;

    if (!imdbId || !imdbId.startsWith('tt')) continue;
    if (isNaN(ratingRaw) || ratingRaw < 1 || ratingRaw > 10) continue;

    const type = TYPE_MAP[titleType];
    if (!type) continue; // TV Episode, Video, etc. → ignora

    results.push({ imdbId, rating: ratingRaw, type, year, title });
  }
  return results;
}

// Importa notas do IMDb a partir de um arquivo CSV.
// Resolve tmdb_id via deps.tmdb.getByImdb quando disponível (opcional).
// Retorna o número de entradas inseridas/atualizadas.
async function importFromCsv(sessionId, filePath, deps = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  const entries = parseCsv(text);
  const dbi = deps.db || require('./db').db;
  const tmdb = deps.tmdb;
  const now = Math.floor(Date.now() / 1000);
  let count = 0;

  for (const entry of entries) {
    let tmdbId = null;
    if (tmdb && typeof tmdb.getByImdb === 'function') {
      try {
        const res = await tmdb.getByImdb(entry.imdbId);
        tmdbId = (res && res.tmdb_id) ? Number(res.tmdb_id) : null;
      } catch {
        // sem tmdb_id: salva sem mapeamento, resolvível depois
      }
    }

    await dbi.execute({
      sql: `INSERT INTO user_ratings (session_id, imdb_id, type, rating, rated_at, tmdb_id, title)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id, imdb_id)
            DO UPDATE SET type=excluded.type, rating=excluded.rating, rated_at=excluded.rated_at,
              tmdb_id=COALESCE(excluded.tmdb_id, user_ratings.tmdb_id),
              title=COALESCE(excluded.title, user_ratings.title)`,
      args: [sessionId, entry.imdbId, entry.type, entry.rating, now, tmdbId, entry.title || null],
    });
    count++;
  }
  return count;
}

module.exports = { parseCsv, importFromCsv };
