/**
 * The HTTP surface. Validation is explicit and local rather than schema-driven:
 * one error shape everywhere, and a 400 that names the field it rejected.
 *
 * `kind` is checked against the same list the database enforces, so a typo is
 * a 400 from the API instead of a constraint violation from Postgres.
 */
import { KINDS } from '../config.js';
import { clampLimit } from '../repo/notes.js';
import { decodeCursor } from '../lib/cursor.js';

const badRequest = (reply, error, extra = {}) => reply.code(400).send({ error, ...extra });

function readTags(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) return null;
  return value.map((t) => t.trim()).filter(Boolean);
}

function readText(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  return value;
}

export function createRoutes({ notes, derived, embeddings, providers, derive, embed, auth }) {
  return async function routes(app) {
    app.get('/health', async () => ({ ok: true }));

    await app.register(async (api) => {
      api.addHook('preHandler', auth);

      api.get('/meta', async () => {
        const capabilities = providers.capabilities();
        return {
          kinds: KINDS,
          ...(await notes.counts()),
          vectors: await embeddings.count(),
          capabilities,
          missing: providers.gaps(),
          // Feature-level truth, derived from the roles: `derive` needs the
          // summary role; `related` needs vectors (the reranker only sharpens
          // an answer that already exists).
          features: {
            derive: capabilities.summary === true,
            related: capabilities.embed === true,
            rerank: capabilities.embed === true && capabilities.related === true,
          },
        };
      });

      api.get('/notes', async (req, reply) => {
        const { kind, tag, q, limit, cursor } = req.query ?? {};
        if (kind && !KINDS.includes(kind)) return badRequest(reply, `unknown kind: ${kind}`, { kinds: KINDS });
        if (cursor && !decodeCursor(cursor)) return badRequest(reply, 'invalid cursor');
        if (tag !== undefined && typeof tag !== 'string') return badRequest(reply, 'tag must be a string');

        const page = await notes.list({ kind, tag, q, limit, cursor });
        return { ...page, limit: clampLimit(limit) };
      });

      api.post('/notes', async (req, reply) => {
        const body = req.body ?? {};
        const kind = body.kind ?? 'note';
        if (!KINDS.includes(kind)) return badRequest(reply, `unknown kind: ${kind}`, { kinds: KINDS });

        const title = readText(body.title ?? '', 'title');
        const text = readText(body.body ?? '', 'body');
        const tags = readTags(body.tags ?? []);
        if (title === null || text === null) return badRequest(reply, 'title and body must be strings');
        if (tags === null) return badRequest(reply, 'tags must be an array of strings');
        if (body.metadata !== undefined && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))) {
          return badRequest(reply, 'metadata must be an object');
        }

        const note = await notes.create({
          kind, title, body: text, tags, metadata: body.metadata ?? {},
        });
        return reply.code(201).send(note);
      });

      api.get('/notes/:id', async (req, reply) => {
        const note = await notes.get(req.params.id);
        if (!note) return reply.code(404).send({ error: 'note not found' });
        return { note, derived: await derived.listForNote(note.id) };
      });

      api.patch('/notes/:id', async (req, reply) => {
        const body = req.body ?? {};
        const patch = {};

        if (body.kind !== undefined) {
          if (!KINDS.includes(body.kind)) return badRequest(reply, `unknown kind: ${body.kind}`, { kinds: KINDS });
          patch.kind = body.kind;
        }
        for (const field of ['title', 'body']) {
          if (body[field] === undefined) continue;
          const value = readText(body[field], field);
          if (value === null) return badRequest(reply, `${field} must be a string`);
          patch[field] = value;
        }
        if (body.tags !== undefined) {
          const tags = readTags(body.tags);
          if (tags === null) return badRequest(reply, 'tags must be an array of strings');
          patch.tags = tags;
        }
        if (body.metadata !== undefined) {
          if (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata)) {
            return badRequest(reply, 'metadata must be an object');
          }
          patch.metadata = body.metadata;
        }

        const note = await notes.update(req.params.id, patch);
        if (!note) return reply.code(404).send({ error: 'note not found' });
        return note;
      });

      api.delete('/notes/:id', async (req, reply) => {
        const removed = await notes.remove(req.params.id);
        if (!removed) return reply.code(404).send({ error: 'note not found' });
        return reply.code(204).send();
      });

      api.post('/notes/:id/derive', async (req, reply) => {
        const result = await derive(req.params.id);

        if (result.ok) return reply.code(201).send(result);
        if (result.reason === 'not_found') return reply.code(404).send({ error: 'note not found' });
        if (result.reason === 'unconfigured') {
          return reply.code(501).send({
            error: 'no summary role configured',
            detail: 'set SUMMARY_BASE_URL and SUMMARY_MODEL (and SUMMARY_API_KEY unless the endpoint is local)',
            missing: result.gaps,
          });
        }
        return reply.code(502).send({ error: 'the model did not produce a usable answer', detail: result.message ?? result.reason });
      });

      const verdict = (value) => async (req, reply) => {
        const item = await derived.setVerdict(req.params.id, value);
        if (!item) return reply.code(404).send({ error: 'derived item not found' });
        return item;
      };

      api.post('/derived/:id/accept', verdict('accept'));
      api.post('/derived/:id/dismiss', verdict('dismiss'));

      // ---- vectors -----------------------------------------------------------

      api.post('/notes/:id/embed', async (req, reply) => {
        const result = await embed.embed(req.params.id);
        if (result.ok) return reply.code(201).send(result);
        if (result.reason === 'not_found') return reply.code(404).send({ error: 'note not found' });
        if (result.reason === 'unconfigured') {
          return reply.code(501).send({
            error: 'no embed role configured',
            detail: 'set EMBED_BASE_URL and EMBED_MODEL (and EMBED_API_KEY unless the endpoint is local)',
            missing: result.gaps,
          });
        }
        if (result.reason === 'dimension_mismatch') {
          return reply.code(409).send({
            error: 'the embedding model returned a different dimension than EMBED_DIMENSIONS',
            expected: result.expected,
            got: result.got,
          });
        }
        return reply.code(502).send({ error: 'the embedding model did not answer', detail: result.message ?? result.reason });
      });

      api.get('/notes/:id/related', async (req, reply) => {
        const asked = Number(req.query?.limit);
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 25) : 5;

        const result = await embed.related(req.params.id, { limit });
        if (result.ok) {
          return {
            items: result.items,
            reranked: result.reranked,
            // Provenance: which models produced this answer. A client that shows a
            // list of neighbours should be able to say what made it, and `rerankError`
            // is how it learns that the model part did not happen.
            ...(result.embedModel ? { embedModel: result.embedModel } : {}),
            ...(result.rerankModel ? { rerankModel: result.rerankModel } : {}),
            ...(result.rerankError ? { rerankError: result.rerankError } : {}),
          };
        }
        if (result.reason === 'not_found') return reply.code(404).send({ error: 'note not found' });
        if (result.reason === 'unconfigured') {
          return reply.code(501).send({ error: 'no embed role configured', missing: result.gaps });
        }
        return reply.code(502).send({ error: 'the embedding model did not answer', detail: result.message ?? result.reason });
      });
    }, { prefix: '/api' });
  };
}
