/**
 * Minimal migration runner: applies every .sql file in ./migrations in
 * filename order, exactly once, tracked in schema_migrations. No down
 * migrations — this is a personal notes app, not a product needing rollback
 * tooling. Each file runs in its own transaction, so a failure leaves the
 * schema at the last good file rather than half-applied.
 *
 * Backend-agnostic: it only uses pool.query and pool.transaction, which both the
 * Postgres and the PGlite adapter provide. Inside a transaction the file goes
 * through `exec`, because a migration file is several statements in one string
 * and PGlite's prepared-statement path rejects that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, 'migrations');

export async function migrate({ pool, logger = console }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];

  for (const file of files) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await pool.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      });
    } catch (err) {
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
    applied.push(file);
    logger.log(`applied ${file}`);
  }

  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadConfig } = await import('../config.js');
  const { createDatabase } = await import('./index.js');
  const pool = await createDatabase(loadConfig().database);
  try {
    const applied = await migrate({ pool });
    console.log(applied.length ? `applied ${applied.length} migration(s)` : 'schema already current');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
