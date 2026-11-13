import pg from 'pg';

/**
 * One pool per process. Nothing here reads the environment: the caller passes
 * the connection string, so tests can point at a scratch database without
 * touching process.env.
 */
export function createPool({ connectionString, max = 10 } = {}) {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
