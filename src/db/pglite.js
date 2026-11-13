import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/**
 * The PGlite adapter: the same Postgres, compiled to wasm, kept in one directory
 * on disk. No server to install and no Docker — which is what makes a
 * download-and-run build possible on Windows (see README, "Windows").
 *
 * Two extensions are handed in explicitly because PGlite ships them as separate
 * bundles while a normal server already has them. pgvector in particular is not
 * optional: without it the `vector` type does not exist and the migrations fail
 * loudly, rather than the app quietly losing semantic search.
 *
 * The same three methods as the Postgres pool, so nothing above this file knows
 * which of the two it is talking to.
 */
export async function createPglite({ dir }) {
  const db = await PGlite.create(dir, { extensions: { vector, pg_trgm } });

  return {
    backend: 'pglite',

    query: (text, params) => db.query(text, params),

    // PGlite is a single wasm connection rather than a pool, so a transaction is
    // a scope, not a separate client. Inside it `exec` is the one that takes
    // several statements at once: `query` goes through the prepared-statement
    // protocol and rejects a multi-statement string with
    // "Transaction was rolled back instead of committed" (measured, not assumed).
    async transaction(fn) {
      return db.transaction((tx) => fn({
        query: (text, params) => tx.query(text, params),
        exec: (sql) => tx.exec(sql),
      }));
    },

    async end() {
      await db.close();
    },
  };
}
