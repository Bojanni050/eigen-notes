import crypto from 'node:crypto';

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/**
 * Bearer auth, fail closed: with no token configured the API answers 503 to
 * everything rather than running open. Comparison is constant-time per token.
 */
export function createAuth({ tokens }) {
  const configured = [...tokens];
  const expected = configured.map(digest);

  return function auth(req, reply, done) {
    if (expected.length === 0) {
      reply.code(503).send({
        error: 'no API token configured',
        detail: 'set NOTES_TOKEN (comma-separated); the API refuses every request without it',
      });
      return;
    }

    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match ? match[1].trim() : '';

    if (provided && expected.some((want) => crypto.timingSafeEqual(digest(provided), want))) {
      done();
      return;
    }

    reply.code(401).send({ error: 'unauthorized' });
  };
}
