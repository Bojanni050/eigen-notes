import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeriveService } from '../../src/service/derive.js';

function harness({ roles = {}, gaps = {} } = {}) {
  const writes = { derived: [], notes: [] };
  const note = { id: 'n1', kind: 'note', title: 'T', body: 'B', tags: [] };

  const notes = {
    get: async () => note,
    update: async (...args) => { writes.notes.push(args); throw new Error('derive must never write to a note'); },
  };
  const derived = {
    insert: async (item) => { writes.derived.push(item); return { id: `d${writes.derived.length}`, ...item }; },
  };
  const providers = {
    role: (name) => roles[name] ?? null,
    missing: (name) => gaps[name] ?? null,
  };

  return {
    writes,
    derive: createDeriveService({ notes, derived, providers, config: { summaryMaxChars: 100 } }),
  };
}

test('a configured summary role writes its tags and summary to the derived side only', async () => {
  const { derive, writes } = harness({
    roles: { summary: { baseUrl: 'https://api.example.com/v1', model: 'cheap-1', summarize: async () => ({ tags: ['a', 'b'], summary: 'een zin' }) } },
  });

  const result = await derive('n1');

  assert.equal(result.ok, true);
  assert.equal(writes.derived.length, 2);
  assert.deepEqual(writes.derived[0].payload, { tags: ['a', 'b'] });
  assert.equal(writes.derived[1].kind, 'summary');
  assert.equal(writes.derived[1].model, 'cheap-1', 'the derived row carries its lineage');
  assert.equal(writes.notes.length, 0, 'the raw side was not touched');
});

test('an absent role is refused with the environment it is missing', async () => {
  const { derive, writes } = harness({ gaps: { summary: ['SUMMARY_BASE_URL', 'SUMMARY_MODEL'] } });

  const result = await derive('n1');

  assert.deepEqual(result, { ok: false, reason: 'unconfigured', gaps: ['SUMMARY_BASE_URL', 'SUMMARY_MODEL'] });
  assert.equal(writes.derived.length, 0, 'nothing is invented when there is no role');
});

test('a failing model is reported, not swallowed into an empty suggestion', async () => {
  const { derive, writes } = harness({
    roles: { summary: { baseUrl: 'https://x/v1', model: 'm', summarize: async () => { throw new Error('429 Too Many Requests'); } } },
  });

  const result = await derive('n1');

  assert.equal(result.reason, 'provider_error');
  assert.match(result.message, /429/);
  assert.equal(writes.derived.length, 0);
});

test('a model that answers nothing usable produces no rows', async () => {
  const { derive } = harness({
    roles: { summary: { baseUrl: 'https://x/v1', model: 'm', summarize: async () => ({ tags: [], summary: '' }) } },
  });

  assert.deepEqual(await derive('n1'), { ok: false, reason: 'empty_suggestion' });
});

test('an unknown note is a not_found, before any role is consulted', async () => {
  const { derive } = harness();
  const service = createDeriveService({
    notes: { get: async () => null },
    derived: { insert: async () => { throw new Error('unreachable'); } },
    providers: { role: () => { throw new Error('no role should be resolved for a missing note'); } },
    config: { summaryMaxChars: 100 },
  });

  assert.deepEqual(await service('missing'), { ok: false, reason: 'not_found' });
  assert.ok(derive); // the harness above is exercised in the other tests
});
