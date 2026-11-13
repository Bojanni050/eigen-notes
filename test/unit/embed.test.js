import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmbedService } from '../../src/service/embed.js';
import { toVectorLiteral } from '../../src/repo/embeddings.js';

const NOTE = { id: 'n1', kind: 'note', title: 'Kwantum', tags: ['natuurkunde'], body: 'qubits en superpositie' };

function harness({ vector = [0.1, 0.2, 0.3], dimensions = null, withEmbedRole = true, withRerankRole = false, nearest = [], rerankThrows = false } = {}) {
  const calls = { embedded: [], upserted: [], nearest: [] };

  const notes = { get: async (id) => (id === NOTE.id ? NOTE : null) };
  const embeddings = {
    upsert: async (row) => {
      calls.upserted.push(row);
      return { noteId: row.noteId, model: row.model, dim: row.vector.length };
    },
    nearest: async (query) => {
      calls.nearest.push(query);
      return nearest;
    },
  };
  const providers = {
    role: (name) => {
      if (name === 'embed' && withEmbedRole) {
        return {
          model: 'fake-embed',
          baseUrl: 'http://fake/v1',
          embed: async (text) => {
            calls.embedded.push(text);
            return vector;
          },
        };
      }
      if (name === 'related' && withRerankRole) {
        return {
          model: 'fake-rerank',
          baseUrl: 'http://fake/v1',
          rerank: async () => {
            if (rerankThrows) throw new Error('429 Too Many Requests');
            return [{ id: 'n2', title: 'B', score: 88, reason: 'same subject' }];
          },
        };
      }
      return null;
    },
    missing: (name) => (name === 'embed' && !withEmbedRole ? ['EMBED_BASE_URL', 'EMBED_MODEL'] : null),
    capabilities: () => ({ summary: false, related: withRerankRole, embed: withEmbedRole }),
  };

  const service = createEmbedService({
    notes,
    embeddings,
    providers,
    config: { embed: { maxChars: 40, dimensions } },
    logger: { warn() {} },
  });

  return { service, calls };
}

test('embed sends the note text (capped), stores the vector and reports its dimension', async () => {
  const { service, calls } = harness();

  const result = await service.embed('n1');

  assert.deepEqual(result, { ok: true, noteId: 'n1', model: 'fake-embed', dim: 3 });
  assert.equal(calls.embedded.length, 1);
  assert.match(calls.embedded[0], /^Kwantum\nnatuurkunde\n/);
  assert.equal(calls.embedded[0].length, 40, 'the text that leaves the machine is capped');
  assert.equal(calls.upserted[0].model, 'fake-embed');
});

test('a dimension that contradicts EMBED_DIMENSIONS is named, not stored', async () => {
  const { service, calls } = harness({ vector: [1, 2, 3], dimensions: 1024 });

  const result = await service.embed('n1');

  assert.deepEqual(result, { ok: false, reason: 'dimension_mismatch', expected: 1024, got: 3 });
  assert.equal(calls.upserted.length, 0);
});

test('without an embed role nothing is silently invented', async () => {
  const { service, calls } = harness({ withEmbedRole: false });

  assert.deepEqual(await service.embed('n1'), {
    ok: false, reason: 'unconfigured', gaps: ['EMBED_BASE_URL', 'EMBED_MODEL'],
  });
  assert.equal(calls.embedded.length, 0);
});

test('an unknown note is not_found', async () => {
  const { service } = harness();
  assert.deepEqual(await service.embed('other'), { ok: false, reason: 'not_found' });
});

test('a failing embed model is reported', async () => {
  const notes = { get: async () => NOTE };
  const service = createEmbedService({
    notes,
    embeddings: { upsert: async () => { throw new Error('unreachable'); }, nearest: async () => [] },
    providers: {
      role: () => ({ model: 'm', embed: async () => { throw new Error('connection refused'); } }),
      missing: () => null,
    },
    config: { embed: { maxChars: 40, dimensions: null } },
    logger: { warn() {} },
  });

  const result = await service.embed('n1');
  assert.equal(result.reason, 'provider_error');
  assert.match(result.message, /connection refused/);
});

test('related returns vector neighbours without a reranker', async () => {
  const neighbours = [{ id: 'n2', kind: 'note', title: 'B', snippet: 's', similarity: 0.91 }];
  const { service, calls } = harness({ nearest: neighbours });

  const result = await service.related('n1', { limit: 5 });

  assert.deepEqual(result, { ok: true, reranked: false, items: neighbours });
  assert.equal(calls.nearest[0].excludeNoteId, 'n1', 'a note is never its own neighbour');
  assert.ok(calls.nearest[0].limit >= 10, 'it fetches more candidates than the caller asked for');
});

test('related uses the reranker when there is one, and keeps the vector answer when it fails', async () => {
  const neighbours = [{ id: 'n2', kind: 'note', title: 'B', snippet: 's', similarity: 0.91 }];

  const withRerank = harness({ nearest: neighbours, withRerankRole: true });
  const reranked = await withRerank.service.related('n1');
  assert.equal(reranked.reranked, true);
  assert.deepEqual(reranked.items, [{ id: 'n2', title: 'B', score: 88, reason: 'same subject' }]);

  const failing = harness({ nearest: neighbours, withRerankRole: true, rerankThrows: true });
  const fallback = await failing.service.related('n1');
  assert.equal(fallback.reranked, false, 'the answer under the reranker is not lost');
  assert.deepEqual(fallback.items, neighbours);
  assert.match(fallback.rerankError, /429/);
});

test('related is refused with the missing environment when there is no embed role', async () => {
  const { service } = harness({ withEmbedRole: false });
  const result = await service.related('n1');
  assert.deepEqual(result, { ok: false, reason: 'unconfigured', gaps: ['EMBED_BASE_URL', 'EMBED_MODEL'], role: 'embed' });
});

test('a vector is formatted as a pgvector literal', () => {
  assert.equal(toVectorLiteral([0.1, -2, 3]), '[0.1,-2,3]');
});
