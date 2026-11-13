import pg from 'pg';

/**
 * The Postgres adapter: one pool per process. Nothing here reads the
 * environment — the caller passes the connection string, so tests can point at a
 * scratch database without touching process.env.
 *
 * The three methods below (query, transaction, end) are the whole database
 * interface this app has, on purpose: they are what lets the same repos, the
 * same migration runner and the same tests run against PGlite too
 * (src/db/pglite.js). Third-party code that wants the raw `pg.Pool` does not
 * belong above this line.
 */
export function createPool({ connectionString, max = 10 } = {}) {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    backend: 'postgres',

    query: (text, params) => pool.query(text, params),

    // A transaction needs its own connection: a pool gives no such guarantee.
    // The migration runner wraps every file in one.
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (text, params) => client.query(text, params),
          // Several statements in one string: the migration files depend on it,
          // and node-postgres allows it as long as nothing is parameterised.
          exec: (sql) => client.query(sql),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    end: () => pool.end(),
  };
}
