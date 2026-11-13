/**
 * One OpenAI-compatible client, used for every role. `fetchImpl` is injected
 * so tests exercise this code with a fake transport instead of a fake client:
 * the retry-free, timeout-bounded path is the same one production runs.
 */
export function createOpenAiCompatible({
  baseUrl,
  apiKey = '',
  model,
  fetchImpl = fetch,
  timeoutMs = 30_000,
}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const err = new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    model,
    baseUrl: root,

    async chat({ system, user, json = false, maxTokens = 800 }) {
      const body = {
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
      };

      const complete = async (payload) => {
        const data = await call('/chat/completions', payload);
        const content = data?.choices?.[0]?.message?.content;
        return typeof content === 'string' ? content : '';
      };

      if (!json) return complete(body);

      try {
        return await complete({ ...body, response_format: { type: 'json_object' } });
      } catch (err) {
        // A provider that refuses `response_format` is not a broken provider:
        // the prompt already demands JSON and the parser strips fences, so the
        // only thing lost by asking without it is a little reliability. Only a
        // request error is retried — never a timeout or a 5xx.
        if (err?.status !== 400 && err?.status !== 422) throw err;
        return complete(body);
      }
    },

    async embed(input) {
      const data = await call('/embeddings', { model, input });
      const vector = data?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('embedding endpoint returned no vector');
      }
      return vector;
    },
  };
}
