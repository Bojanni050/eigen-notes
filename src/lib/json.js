/**
 * Model output is text until proven otherwise. This turns "strict JSON, it
 * says" into something a caller can handle: either a parsed value or a thrown
 * error naming what came back. Nothing here repairs a broken answer into a
 * plausible one — an unparseable reply is a failure, not a summary.
 */
export function parseJsonReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('model returned an empty body');

  let candidate = raw;
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  }

  try {
    return JSON.parse(candidate);
  } catch {
    // Some models chat around the JSON; the first bracket pair is the payload.
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* falls through to the error below */
      }
    }
    throw new Error(`model reply was not JSON: ${raw.slice(0, 120)}`);
  }
}
