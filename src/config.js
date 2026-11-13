/**
 * Every environment read in this app goes through here, once. Defaults make a
 * fresh checkout work against the compose database; nothing else is inferred.
 */
export const KINDS = [
  'note', 'person', 'task', 'idea', 'book', 'project', 'meeting', 'daily',
];

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;

export function loadConfig(env = process.env) {
  return {
    port: Number(env.API_PORT || 8899),
    host: env.API_HOST || '127.0.0.1',
    // Which database this process talks to. `postgres` is the compose stack and
    // any real server; `pglite` is Postgres compiled to wasm in a directory,
    // which needs nothing installed (the Windows build uses it).
    database: {
      backend: env.DB_BACKEND || 'postgres',
      url: env.DATABASE_URL || 'postgres://eigen_notes:eigen_notes@127.0.0.1:5433/eigen_notes',
      dir: env.DB_DIR || './data/pglite',
    },
    // Kept for callers that only want the connection string; the backend choice
    // is what actually decides.
    get databaseUrl() {
      return this.database.url;
    },
    // Comma-separated. Empty means fail closed: the API refuses everything.
    tokens: String(env.NOTES_TOKEN || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    summaryMaxChars: Number(env.SUMMARY_MAX_CHARS || 4000),
    embed: {
      dimensions: Number(env.EMBED_DIMENSIONS || 0) || null,
      maxChars: Number(env.EMBED_MAX_CHARS || 8000),
    },
  };
}
