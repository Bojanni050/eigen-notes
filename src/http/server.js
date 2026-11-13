import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createNotesRepo } from '../repo/notes.js';
import { createDerivedRepo } from '../repo/derived.js';
import { createEmbeddingsRepo } from '../repo/embeddings.js';
import { createProviders } from '../providers/index.js';
import { createDeriveService } from '../service/derive.js';
import { createEmbedService } from '../service/embed.js';
import { createAuth } from './auth.js';
import { createRoutes } from './routes.js';

/**
 * Everything is injected, so tests run the real server against a scratch
 * database and a fake provider without a single process.env write.
 */
export function createServer({ config, pool, providers, logger = console }) {
  const notes = createNotesRepo({ pool });
  const derived = createDerivedRepo({ pool });
  const embeddings = createEmbeddingsRepo({ pool });
  const derive = createDeriveService({ notes, derived, providers, config, logger });
  const embed = createEmbedService({ notes, embeddings, providers, config, logger });

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
    logger.error?.(`[http] ${req.method} ${req.url}: ${err.message}`);
    reply.code(500).send({ error: 'internal error' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not found' }));
  app.register(createRoutes({
    notes, derived, embeddings, providers, derive, embed, auth: createAuth({ tokens: config.tokens }),
  }));

  return { app, notes, derived, embeddings, derive, embed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl });
  const providers = createProviders();
  const { app } = createServer({ config, pool, providers });

  const shutdown = async (signal) => {
    console.log(`[eigen-notes] ${signal} — closing`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  const roles = providers.capabilities();
  console.log(`[eigen-notes] listening on http://${config.host}:${config.port}`);
  console.log(`[eigen-notes] roles: ${Object.entries(roles).map(([r, on]) => `${r}=${on ? 'on' : 'off'}`).join(' ')}`);
  if (config.tokens.length === 0) {
    console.warn('[eigen-notes] NOTES_TOKEN is empty — every request gets 503 until it is set');
  }
}
