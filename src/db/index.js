import { createPool } from './pool.js';
import { createPglite } from './pglite.js';

export const BACKENDS = ['postgres', 'pglite'];

/**
 * Picks a backend by name. `postgres` takes a connection string and is what the
 * compose stack uses; `pglite` takes a directory and needs nothing installed.
 *
 * Both return the same three methods (query, transaction, end), so this is the
 * only place in the app that knows there is more than one.
 */
export async function createDatabase({ backend = 'postgres', url, dir } = {}) {
  if (backend === 'postgres') return createPool({ connectionString: url });
  if (backend === 'pglite') return createPglite({ dir });
  throw new Error(`unknown database backend: ${backend} (expected ${BACKENDS.join(' or ')})`);
}
