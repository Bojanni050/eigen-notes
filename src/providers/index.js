/**
 * Three roles, each independently configurable through the environment:
 *
 *   summary  — 3-6 tags + one sentence for a note
 *   related  — reranks vector candidates and says *why* they match
 *   embed    — vectors, so `related` starts from pgvector instead of "send
 *              every note to a model"
 *
 * The rule this file exists to enforce: a role is present only when it is
 * fully configured (base URL *and* model — a key is optional, because a local
 * endpoint has none). Anything else is reported as missing on GET /api/meta
 * and refused by the feature, never papered over with invented output.
 *
 * `LLM_BASE_URL` / `LLM_API_KEY` are a shared fallback for roles that have no
 * value of their own.
 */
import { createOpenAiCompatible } from './openaiCompatible.js';
import { parseJsonReply } from '../lib/json.js';

const ROLE_SPECS = [
  { role: 'summary', prefix: 'SUMMARY' },
  { role: 'related', prefix: 'RELATED' },
  { role: 'embed', prefix: 'EMBED' },
];

const SUMMARY_SYSTEM = [
  'You extract topic tags and one short summary from a personal note.',
  'Reply with strict JSON only — no prose, no markdown, no explanation.',
].join(' ');

const RELATED_SYSTEM = [
  'You rank candidate notes by how related they really are to a given note,',
  'for a personal knowledge base. Reply with strict JSON only.',
].join(' ');

export function createProviders({ env = process.env, fetchImpl = fetch } = {}) {
  const sharedBase = String(env.LLM_BASE_URL || '').trim();
  const sharedKey = String(env.LLM_API_KEY || '').trim();

  const roles = new Map();
  const missing = new Map();

  for (const spec of ROLE_SPECS) {
    const baseUrl = String(env[`${spec.prefix}_BASE_URL`] || sharedBase || '').trim();
    const apiKey = String(env[`${spec.prefix}_API_KEY`] || sharedKey || '').trim();
    const model = String(env[`${spec.prefix}_MODEL`] || '').trim();

    const gaps = [];
    if (!baseUrl) gaps.push(`${spec.prefix}_BASE_URL`);
    if (!model) gaps.push(`${spec.prefix}_MODEL`);
    if (gaps.length > 0) {
      missing.set(spec.role, gaps);
      continue;
    }

    const client = createOpenAiCompatible({ baseUrl, apiKey, model, fetchImpl });
    if (spec.role === 'summary') client.summarize = (note, opts) => summarize(client, note, opts);
    if (spec.role === 'related') client.rerank = (note, candidates) => rerank(client, note, candidates);

    roles.set(spec.role, client);
  }

  return {
    role: (name) => roles.get(name) ?? null,
    missing: (name) => missing.get(name) ?? null,
    capabilities: () => Object.fromEntries(ROLE_SPECS.map((s) => [s.role, roles.has(s.role)])),
    gaps: () => Object.fromEntries([...missing.entries()]),
  };
}

/** Lowercase it, strip what the prompt forbade anyway, dedupe, cap at 6. */
export function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    const tag = String(raw ?? '')
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .trim();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === 6) break;
  }
  return out;
}

async function summarize(client, note, { maxChars = 4000 } = {}) {
  const body = String(note.body ?? '').slice(0, maxChars);

  const user = [
    `Kind: ${note.kind}`,
    `Title: ${note.title || '(untitled)'}`,
    '',
    'Body:',
    body || '(empty)',
    '',
    'Return exactly this shape:',
    '{"tags": ["tag1", "tag2", "tag3"], "summary": "one sentence"}',
    '',
    'Rules: 3-6 tags, lowercase, single words or two words, no punctuation, no #,',
    'no duplicates. The summary is one sentence, in the same language as the note,',
    'and says what the note is about — not what you did with it.',
  ].join('\n');

  const parsed = parseJsonReply(await client.chat({ system: SUMMARY_SYSTEM, user, json: true }));
  return {
    tags: normalizeTags(parsed?.tags),
    summary: String(parsed?.summary ?? '').trim().slice(0, 400),
  };
}

async function rerank(client, note, candidates = []) {
  if (!candidates.length) return [];

  // Numbered candidates, not UUIDs: a small model cannot be trusted to echo a
  // 36-character id, and a mangled id silently drops a real hit. A number is
  // one token, and an out-of-range number is easy to reject.
  const lines = candidates.map((c, i) => [
    `${i + 1}. title=${c.title || '(untitled)'}`,
    `similarity=${typeof c.similarity === 'number' ? c.similarity.toFixed(3) : 'n/a'}`,
    `snippet=${String(c.snippet || '').slice(0, 200)}`,
  ].join(' | '));

  const user = [
    'Current note:',
    `type=${note.kind} | title=${note.title || '(untitled)'}`,
    `tags=${(note.tags || []).join(', ')}`,
    `body=${String(note.body ?? '').slice(0, 600)}`,
    '',
    'Candidates (numbered):',
    ...lines,
    '',
    'Decide which candidates are genuinely about the same subject as the current note.',
    '',
    'Answer with a JSON object with a single key "matches". Its value is a list; every',
    'entry has "number" (the candidate number you picked), "score" (an integer from 0',
    'to 100 for how related it is) and "reason" (one short clause, in the note\'s own',
    'language, naming the subject the two share).',
    '',
    'Use only numbers from the list above and at most five entries. If nothing on the',
    'list is genuinely related, answer {"matches": []}.',
  ].join('\n');

  // No filled-in example anywhere in this prompt on purpose. With one
  // (`{"number": 2, "score": 0-100, "reason": "short reason"}`) qwen2.5-3b
  // answered literally that — number 1, score 0, reason "short reason" — which
  // reaches a caller as a real hit. Prose keys cost nothing and cannot be copied.
  const raw = parseJsonReply(await client.chat({ system: RELATED_SYSTEM, user, json: true, maxTokens: 700 }));

  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.matches)) {
    throw new Error(`rerank reply had no "matches" array: ${JSON.stringify(raw).slice(0, 120)}`);
  }

  const out = [];
  for (const match of raw.matches.slice(0, 5)) {
    const number = Number(match?.number);
    if (!Number.isInteger(number) || number < 1 || number > candidates.length) continue; // invented → dropped
    const candidate = candidates[number - 1];
    const score = Number(match?.score);
    out.push({
      id: candidate.id,
      title: candidate.title || '',
      score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
      reason: String(match?.reason ?? '').slice(0, 200),
    });
  }

  // An answer that names candidates but ranks none of them (score 0 and no real
  // reason) is not a quiet "nothing is related" — it is a reply that failed to do
  // the job. Surfacing it as an error is what lets the caller fall back to the
  // vector order instead of showing a list that looks answered but is not.
  const ranked = out.filter((m) => m.score > 0 && m.reason.length >= 8);
  if (out.length > 0 && ranked.length === 0) {
    throw new Error('rerank named candidates but ranked none of them (no score, no reason)');
  }
  return ranked;
}
