/**
 * Keyset cursor for `ORDER BY updated_at DESC, id DESC`.
 *
 * Base64url of `<iso timestamp>|<uuid>`: opaque to a client, cheap for the
 * database (one index range scan, never an OFFSET), and stable while rows are
 * being written — which an offset never is.
 */
export function encodeCursor(row) {
  const stamp = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt);
  return Buffer.from(`${stamp}|${row.id}`, 'utf8').toString('base64url');
}

/** Returns { updatedAt, id } or null when the cursor is missing or malformed. */
export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;

  let raw;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  // The timestamp never contains a pipe, so the FIRST one is the separator and
  // anything after it belongs to the id.
  const split = raw.indexOf('|');
  if (split < 1) return null;

  const stamp = raw.slice(0, split);
  const id = raw.slice(split + 1);
  const when = new Date(stamp);
  if (!id || Number.isNaN(when.getTime())) return null;

  return { updatedAt: when.toISOString(), id };
}
