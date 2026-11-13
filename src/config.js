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
    databaseUrl: env.DATABASE_URL || 'postgres://eigen_notes:eigen_notes@127.0.0.1:5433/eigen_notes',
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
