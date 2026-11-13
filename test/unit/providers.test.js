import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviders, normalizeTags } from '../../src/providers/index.js';
import { createOpenAiCompatible } from '../../src/providers/openaiCompatible.js';
import { parseJsonReply } from '../../src/lib/json.js';

const jsonResponse = (payload) => async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => payload,
});

test('a role is present only when base URL and model are set', () => {
  const none = createProviders({ env: {} });
  assert.deepEqual(none.capabilities(), { summary: false, related: false, embed: false });
  assert.deepEqual(none.missing('summary'), ['SUMMARY_BASE_URL', 'SUMMARY_MODEL']);

  const partial = createProviders({ env: { SUMMARY_BASE_URL: 'http://localhost:11434/v1' } });
  assert.equal(partial.capabilities().summary, false, 'a base URL alone is not a role');
  assert.deepEqual(partial.missing('summary'), ['SUMMARY_MODEL']);

  const local = createProviders({ env: { SUMMARY_BASE_URL: 'http://localhost:11434/v1', SUMMARY_MODEL: 'llama3.1' } });
  assert.equal(local.capabilities().summary, true, 'a local endpoint needs no API key');
  assert.equal(local.missing('summary'), null);
});

test('the shared LLM_BASE_URL/LLM_API_KEY fill a role that has no value of its own', () => {
  const providers = createProviders({
    env: { LLM_BASE_URL: 'https://api.example.com/v1', LLM_API_KEY: 'shared', EMBED_MODEL: 'text-embed-3-small' },
  });
  assert.equal(providers.capabilities().embed, true);
  assert.equal(providers.role('embed').model, 'text-embed-3-small');
});

test('an explicit role value beats the shared fallback', () => {
  const providers = createProviders({
    env: {
      LLM_BASE_URL: 'https://shared.example.com/v1',
      RELATED_BASE_URL: 'https://own.example.com/v1',
      RELATED_MODEL: 'reranker-1',
    },
  });
  assert.equal(providers.role('related').baseUrl, 'https://own.example.com/v1');
});

test('normalizeTags lowercases, strips # and punctuation, dedupes and caps at six', () => {
  assert.deepEqual(
    normalizeTags(['#Quantum', 'quantum', 'Quantum Computing', 'film!', 'a', 'b', 'c', 'd', 'e', 'f']),
    ['quantum', 'quantum computing', 'film', 'a', 'b', 'c'],
  );
  assert.deepEqual(normalizeTags('not an array'), []);
});

test('parseJsonReply unwraps a fenced body and rejects a non-JSON answer', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure! {"a":1} — hope that helps'), { a: 1 });
  assert.throws(() => parseJsonReply('I cannot help with that.'), /not JSON/);
  assert.throws(() => parseJsonReply('   '), /empty body/);
});

test('summarize validates the model answer and truncates the body it sends', async () => {
  let seen = null;
  const providers = createProviders({
    env: { SUMMARY_BASE_URL: 'https://api.example.com/v1', SUMMARY_MODEL: 'cheap-1', SUMMARY_API_KEY: 'k', SUMMARY_MAX_CHARS: '10' },
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return jsonResponse({ choices: [{ message: { content: '```json\n{"tags":["#One","one","two"],"summary":"Hi."}\n```' } }] })();
    },
  });

  const out = await providers.role('summary').summarize(
    { kind: 'note', title: 'T', body: 'x'.repeat(50) },
    { maxChars: 10 },
  );

  assert.deepEqual(out, { tags: ['one', 'two'], summary: 'Hi.' });
  assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seen.body.model, 'cheap-1');
  assert.ok(seen.body.messages[1].content.includes('x'.repeat(10)));
  assert.ok(!seen.body.messages[1].content.includes('x'.repeat(11)), 'the body must be capped before it leaves the machine');
});

test('rerank maps numbered candidates back to real ids and drops invented numbers', async () => {
  const providers = createProviders({
    env: { RELATED_BASE_URL: 'https://api.example.com/v1', RELATED_MODEL: 'rerank-1', RELATED_API_KEY: 'k' },
    fetchImpl: jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        matches: [
          { number: 1, score: 91, reason: 'same project' },
          { number: 9, score: 99, reason: 'no such candidate' },
        ],
      }) } }],
    }),
  });

  const out = await providers.role('related').rerank(
    { kind: 'note', title: 'T', body: 'B', tags: [] },
    [{ id: 'real', title: 'Real', snippet: 's', similarity: 0.8 }],
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'real');
  assert.equal(out[0].score, 91);
});

test('rerank numbers the candidates and never sends their real ids', async () => {
  let sent = null;
  const providers = createProviders({
    env: { RELATED_BASE_URL: 'https://api.example.com/v1', RELATED_MODEL: 'r', RELATED_API_KEY: 'k' },
    fetchImpl: async (url, init) => {
      sent = init.body;
      return jsonResponse({ choices: [{ message: { content: '{"matches": []}' } }] })();
    },
  });

  await providers.role('related').rerank(
    { kind: 'note', title: 'T', body: 'B', tags: [] },
    [{ id: 'uuid-here', title: 'A', snippet: 's', similarity: 0.5 }],
  );

  assert.ok(sent.includes('1. title=A'), 'candidates are numbered, so a small model can answer');
  assert.ok(!sent.includes('uuid-here'), 'the real id never reaches the model');
});

test('an empty matches array is an honest "nothing related"; a reply without one is a failure', async () => {
  const build = (content) => createProviders({
    env: { RELATED_BASE_URL: 'https://api.example.com/v1', RELATED_MODEL: 'r', RELATED_API_KEY: 'k' },
    fetchImpl: jsonResponse({ choices: [{ message: { content } }] }),
  });
  const note = { kind: 'note', title: 'T', body: 'B', tags: [] };
  const candidates = [{ id: 'a', title: 'A', snippet: 's', similarity: 0.5 }];

  assert.deepEqual(await build('{"matches": []}').role('related').rerank(note, candidates), []);

  // A literal `{}` (what qwen2.5-3b answers when a JSON-mode request asks for an
  // array) must surface as a failure, so the caller can fall back to the vector
  // order and say the rerank did not happen.
  await assert.rejects(
    () => build('{}').role('related').rerank(note, candidates),
    /no "matches" array/,
  );

  // Naming a candidate while ranking nothing is the parrot case measured live:
  // number 1, score 0, the prompt's own wording as the reason. A failure, not a hit.
  await assert.rejects(
    () => build('{"matches": [{"number": 1, "score": 0, "reason": "short reason"}]}').role('related').rerank(note, candidates),
    /ranked none of them/,
  );
});

test('a non-2xx answer becomes a typed error, and embeds return no vector loudly', async () => {
  const client = createOpenAiCompatible({
    baseUrl: 'https://api.example.com/v1/',
    model: 'm',
    fetchImpl: async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'slow down' }),
  });
  await assert.rejects(() => client.chat({ user: 'hi' }), (err) => err.status === 429 && /slow down/.test(err.message));

  const empty = createOpenAiCompatible({
    baseUrl: 'https://api.example.com/v1',
    model: 'm',
    fetchImpl: jsonResponse({ data: [] }),
  });
  await assert.rejects(() => empty.embed('text'), /no vector/);
});
