/**
 * The real server against a real Postgres, with a fake provider — so the SQL,
 * the cursor, the auth hook and the raw/derived invariant are all exercised by
 * the code that runs in production.
 *
 * Needs DATABASE_URL (see README). Every test starts from an empty database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import path from 'node:path';
import os from 'node:os';
import { createDatabase } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';
import { createServer } from '../../src/http/server.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://eigen_notes:eigen_notes@127.0.0.1:5433/eigen_notes';
const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Which backend this suite runs on. A DATABASE_URL means there is a Postgres to
 * talk to; with none there is nothing to install, so the suite runs on PGlite in
 * a throwaway directory — the same migrations, the same SQL, the same tests. That
 * is what makes `npm test` work on a bare checkout, Windows included.
 */
const BACKEND = process.env.DB_BACKEND || (process.env.DATABASE_URL ? 'postgres' : 'pglite');
const PGLITE_DIR = process.env.PGLITE_DIR || path.join(os.tmpdir(), `eigen-notes-test-${process.pid}`);
const backendArgs = () => (BACKEND === 'pglite' ? { backend: 'pglite', dir: PGLITE_DIR } : { backend: 'postgres', url: DATABASE_URL });

function fakeProviders({ configured = true, withEmbed = true, withRerank = false, rerankThrows = false } = {}) {
  const summarize = async () => ({ tags: ['quantum', 'film'], summary: 'Over qubits en film.' });
  const summary = configured
    ? { baseUrl: 'https://api.example.com/v1', model: 'fake-summary', summarize }
    : null;

  // Deterministic vectors, so the nearest-neighbour order in the tests is a
  // statement about the SQL and not about a model.
  const vectorFor = (text) => {
    const t = String(text).toLowerCase();
    if (t.includes('kwantum')) return [1, 0, 0];
    if (t.includes('film')) return [0, 1, 0];
    if (t.includes('boodschappen')) return [0, 0, 1];
    return [0.5, 0.5, 0.5];
  };
  const embed = withEmbed
    ? { baseUrl: 'https://api.example.com/v1', model: 'fake-embed', embed: async (text) => vectorFor(text) }
    : null;
  const related = withRerank
    ? {
      baseUrl: 'https://api.example.com/v1',
      model: 'fake-rerank',
      rerank: rerankThrows
        ? async () => { throw new Error('rerank exploded'); }
        : async (note, candidates) => candidates
          .slice(0, 1)
          .map((c) => ({ id: c.id, title: c.title, score: 97, reason: 'fake rerank' })),
    }
    : null;

  const gaps = {};
  if (!configured) gaps.summary = ['SUMMARY_BASE_URL', 'SUMMARY_MODEL'];
  if (!withEmbed) gaps.embed = ['EMBED_BASE_URL', 'EMBED_MODEL'];

  return {
    role: (name) => ({ summary, embed, related }[name] ?? null),
    missing: (name) => gaps[name] ?? null,
    capabilities: () => ({ summary: configured, related: withRerank, embed: withEmbed }),
    gaps: () => gaps,
  };
}

async function boot({ withProvider = true, withEmbed = true, withRerank = false, rerankThrows = false } = {}) {
  const pool = await createDatabase(backendArgs());
  await migrate({ pool, logger: { log() {} } });
  await pool.query('TRUNCATE notes CASCADE');

  const config = {
    tokens: [TOKEN],
    summaryMaxChars: 1000,
    embed: { maxChars: 8000, dimensions: null },
    port: 0,
    host: '127.0.0.1',
  };
  const providers = fakeProviders({ configured: withProvider, withEmbed, withRerank, rerankThrows });
  const { app } = createServer({ config, pool, providers, logger: { error() {}, warn() {} } });
  return { app, pool };
}

test('health is open; everything under /api needs the token', async (t) => {
  const { app, pool } = await boot();
  t.after(async () => { await app.close(); await pool.end(); });

  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/meta' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/meta', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/meta', headers: auth })).statusCode, 200);
});

test('with no token configured the API refuses everything (fail closed)', async (t) => {
  const pool = await createDatabase({ ...backendArgs() });
  const { app } = createServer({
    config: { tokens: [], summaryMaxChars: 100, port: 0, host: '127.0.0.1' },
    pool,
    providers: fakeProviders(),
    logger: { error() {}, warn() {} },
  });
  t.after(async () => { await app.close(); await pool.end(); });

  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200, 'health stays open');

  const refused = await app.inject({ method: 'GET', url: '/api/notes', headers: auth });
  assert.equal(refused.statusCode, 503);
  assert.match(refused.json().detail, /NOTES_TOKEN/);
});

test('meta reports which roles really exist', async (t) => {
  const { app, pool } = await boot({ withProvider: false, withEmbed: false });
  t.after(async () => { await app.close(); await pool.end(); });

  const body = (await app.inject({ method: 'GET', url: '/api/meta', headers: auth })).json();
  assert.deepEqual(body.kinds.length, 8);
  assert.deepEqual(body.capabilities, { summary: false, related: false, embed: false });
  assert.deepEqual(body.features, { derive: false, related: false, rerank: false });
  assert.deepEqual(body.missing.summary, ['SUMMARY_BASE_URL', 'SUMMARY_MODEL']);
  assert.deepEqual(body.vectors, [], 'no model, no vectors');
});

test('meta says related is available as soon as vectors are, without a reranker', async (t) => {
  const { app, pool } = await boot({ withRerank: false, withEmbed: true });
  t.after(async () => { await app.close(); await pool.end(); });

  const body = (await app.inject({ method: 'GET', url: '/api/meta', headers: auth })).json();
  assert.deepEqual(body.capabilities, { summary: true, related: false, embed: true });
  assert.deepEqual(body.features, { derive: true, related: true, rerank: false });
});

test('CRUD, kinds and validation', async (t) => {
  const { app, pool } = await boot();
  t.after(async () => { await app.close(); await pool.end(); });

  const created = await app.inject({
    method: 'POST', url: '/api/notes', headers: auth,
    payload: { kind: 'book', title: 'De ontdekking van de hemel', body: 'roman', tags: ['fictie'] },
  });
  assert.equal(created.statusCode, 201);
  const note = created.json();
  assert.equal(note.kind, 'book');
  assert.equal(note.tags[0], 'fictie');

  assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { kind: 'bogus' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { tags: 'nope' } })).statusCode, 400);

  const patched = await app.inject({ method: 'PATCH', url: `/api/notes/${note.id}`, headers: auth, payload: { title: 'Hemel' } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().title, 'Hemel');
  assert.ok(patched.json().updatedAt > note.updatedAt, 'the database trigger moves updated_at');

  const got = await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: auth });
  assert.equal(got.json().note.title, 'Hemel');
  assert.deepEqual(got.json().derived, []);

  assert.equal((await app.inject({ method: 'GET', url: '/api/notes/not-a-uuid', headers: auth })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers: auth })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers: auth })).statusCode, 404);
});

test('list filters by kind and tag, searches full text and substring, and pages with a stable cursor', async (t) => {
  const { app, pool } = await boot();
  t.after(async () => { await app.close(); await pool.end(); });

  const seed = [
    { kind: 'note', title: 'Kwantumcomputers', body: 'qubits en superpositie', tags: ['natuurkunde'] },
    { kind: 'person', title: 'Marie', body: 'fotograaf, donkere kamer', tags: ['vrienden'] },
    { kind: 'idea', title: 'Filmavond', body: 'programmeren rond fotografie', tags: ['vrienden'] },
    { kind: 'task', title: 'Boodschappen', body: 'melk eieren brood', tags: ['huishouden'] },
  ];
  for (const payload of seed) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload })).statusCode, 201);
    await pause(3); // distinct clock_timestamp() values, so the page order is real
  }

  const byKind = (await app.inject({ method: 'GET', url: '/api/notes?kind=person', headers: auth })).json();
  assert.equal(byKind.items.length, 1);
  assert.equal(byKind.items[0].title, 'Marie');

  const byTag = (await app.inject({ method: 'GET', url: '/api/notes?tag=vrienden', headers: auth })).json();
  assert.equal(byTag.items.length, 2);

  const fts = (await app.inject({ method: 'GET', url: '/api/notes?q=qubits', headers: auth })).json();
  assert.equal(fts.items.length, 1, 'full-text finds the body');
  assert.equal(fts.items[0].title, 'Kwantumcomputers');

  const substring = (await app.inject({ method: 'GET', url: '/api/notes?q=programmeren', headers: auth })).json();
  assert.equal(substring.items.length, 1, 'substring finds a word mid-body');

  const wildcard = (await app.inject({ method: 'GET', url: '/api/notes?q=%25', headers: auth })).json();
  assert.equal(wildcard.items.length, 0, 'a % is a literal, not a wildcard');

  const first = (await app.inject({ method: 'GET', url: '/api/notes?limit=2', headers: auth })).json();
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);

  const second = (await app.inject({ method: 'GET', url: `/api/notes?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, headers: auth })).json();
  assert.equal(second.items.length, 2);
  const ids = new Set([...first.items, ...second.items].map((n) => n.id));
  assert.equal(ids.size, 4, 'no row appears twice across pages');
  assert.equal(second.nextCursor, null);

  assert.equal((await app.inject({ method: 'GET', url: '/api/notes?cursor=garbage', headers: auth })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/notes?kind=wrong', headers: auth })).statusCode, 400);
});

test('derive writes to the derived side and leaves the note byte-identical', async (t) => {
  const { app, pool } = await boot();
  t.after(async () => { await app.close(); await pool.end(); });

  const note = (await app.inject({
    method: 'POST', url: '/api/notes', headers: auth,
    payload: { kind: 'note', title: 'Kwantum', body: 'qubits' },
  })).json();

  const derived = await app.inject({ method: 'POST', url: `/api/notes/${note.id}/derive`, headers: auth });
  assert.equal(derived.statusCode, 201);
  const items = derived.json().items;
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'tag_suggestion');
  assert.equal(items[0].model, 'fake-summary');
  assert.equal(items[0].acceptedAt, null);

  const after = (await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: auth })).json();
  assert.deepEqual(after.note.body, note.body, 'the note itself is untouched');
  assert.deepEqual(after.note.tags, [], 'the raw note has no AI tags — they live on the derived side');
  assert.equal(after.note.updatedAt, note.updatedAt, 'not even updated_at moves');
  assert.equal(after.derived.length, 2);

  const accepted = await app.inject({ method: 'POST', url: `/api/derived/${items[0].id}/accept`, headers: auth });
  assert.equal(accepted.statusCode, 200);
  assert.ok(accepted.json().acceptedAt);

  const dismissed = await app.inject({ method: 'POST', url: `/api/derived/${items[0].id}/dismiss`, headers: auth });
  assert.ok(dismissed.json().dismissedAt, 'a change of mind replaces the verdict');
  assert.equal(dismissed.json().acceptedAt, null, 'and clears the other one');

  assert.equal((await app.inject({ method: 'POST', url: '/api/derived/00000000-0000-4000-8000-000000000000/accept', headers: auth })).statusCode, 404);
});

test('without a summary role, derive says so instead of answering', async (t) => {
  const { app, pool } = await boot({ withProvider: false });
  t.after(async () => { await app.close(); await pool.end(); });

  const note = (await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { title: 'x' } })).json();
  const res = await app.inject({ method: 'POST', url: `/api/notes/${note.id}/derive`, headers: auth });

  assert.equal(res.statusCode, 501);
  const body = res.json();
  assert.deepEqual(body.missing, ['SUMMARY_BASE_URL', 'SUMMARY_MODEL']);
  assert.equal((await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers: auth })).json().derived.length, 0);
});

test('deleting a note takes its derived items with it', async (t) => {
  const { app, pool } = await boot();
  t.after(async () => { await app.close(); await pool.end(); });

  const note = (await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { title: 'tijdelijk' } })).json();
  const derived = (await app.inject({ method: 'POST', url: `/api/notes/${note.id}/derive`, headers: auth })).json();
  await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers: auth });

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM derived_items WHERE id = $1::uuid', [derived.items[0].id]);
  assert.equal(rows[0].n, 0, 'the cascade holds');
});

test('related needs vectors: with no embed role it says so instead of guessing', async (t) => {
  const { app, pool } = await boot({ withEmbed: false });
  t.after(async () => { await app.close(); await pool.end(); });

  const note = (await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload: { title: 'Kwantum' } })).json();
  const res = await app.inject({ method: 'GET', url: `/api/notes/${note.id}/related`, headers: auth });

  assert.equal(res.statusCode, 501);
  assert.deepEqual(res.json().missing, ['EMBED_BASE_URL', 'EMBED_MODEL']);
});

test('related orders by distance without a reranker, and the query note needs no vector of its own', async (t) => {
  const { app, pool } = await boot({ withRerank: false, withEmbed: true });
  t.after(async () => { await app.close(); await pool.end(); });

  const make = async (payload) => (await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload })).json();
  const query = await make({ title: 'Kwantum', body: 'qubits' }); // deliberately never embedded
  const near = await make({ title: 'Kwantum extra', body: 'kwantum qubits' });
  const far = await make({ title: 'Boodschappen', body: 'boodschappen melk' });
  for (const note of [near, far]) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/notes/${note.id}/embed`, headers: auth })).statusCode, 201);
  }

  const body = (await app.inject({ method: 'GET', url: `/api/notes/${query.id}/related`, headers: auth })).json();
  assert.equal(body.reranked, false);
  assert.equal(body.embedModel, 'fake-embed');
  assert.equal(body.items[0].id, near.id, 'the identical vector ranks first');
  assert.ok(body.items[0].similarity > 0.99, 'the distance comes back with the hit');
  assert.equal(body.items[1].id, far.id);
});

test('a reranker adds a why without erasing the distance underneath it', async (t) => {
  const { app, pool } = await boot({ withRerank: true });
  t.after(async () => { await app.close(); await pool.end(); });

  const make = async (payload) => (await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload })).json();
  const query = await make({ title: 'Kwantum', body: 'qubits' });
  const near = await make({ title: 'Kwantum extra', body: 'kwantum qubits' });
  await app.inject({ method: 'POST', url: `/api/notes/${near.id}/embed`, headers: auth });

  const body = (await app.inject({ method: 'GET', url: `/api/notes/${query.id}/related`, headers: auth })).json();
  assert.equal(body.reranked, true);
  assert.equal(body.rerankModel, 'fake-rerank');
  assert.equal(body.items[0].id, near.id, 'a reranker cannot introduce an id that was not a candidate');
  assert.equal(body.items[0].score, 97);
  assert.equal(body.items[0].reason, 'fake rerank');
  assert.ok(body.items[0].similarity > 0.99, 'the measured distance survives the rerank');
  assert.ok(body.items[0].snippet, 'and so does the snippet the reranker was shown');
});

test('a reranker that fails falls back to the vector order and says why', async (t) => {
  const { app, pool } = await boot({ withRerank: true, rerankThrows: true });
  t.after(async () => { await app.close(); await pool.end(); });

  const make = async (payload) => (await app.inject({ method: 'POST', url: '/api/notes', headers: auth, payload })).json();
  const query = await make({ title: 'Kwantum', body: 'qubits' });
  const near = await make({ title: 'Kwantum extra', body: 'kwantum qubits' });
  await app.inject({ method: 'POST', url: `/api/notes/${near.id}/embed`, headers: auth });

  const body = (await app.inject({ method: 'GET', url: `/api/notes/${query.id}/related`, headers: auth })).json();
  assert.equal(body.reranked, false);
  assert.match(body.rerankError, /rerank exploded/);
  assert.equal(body.items[0].id, near.id, 'the vector answer is still underneath');
});
