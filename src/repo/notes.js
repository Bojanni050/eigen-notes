/**
 * The raw side's SQL. Every filter is a parameter; the only string that is
 * ever interpolated is a whitelisted column or a placeholder index.
 *
 * Ordering is always `updated_at DESC, id DESC` — including for a search — so
 * there is exactly one pagination model to reason about, and the keyset cursor
 * is valid for every query the API can produce.
 */
import { DEFAULT_LIMIT, MAX_LIMIT } from '../config.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';

const COLUMNS = 'id, kind, title, body, tags, metadata, created_at, updated_at';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATCHABLE = ['kind', 'title', 'body', 'tags', 'metadata'];

export function clampLimit(value, { fallback = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/** `%` and `_` are wildcards in ILIKE; a search term must not smuggle them in. */
const escapeLike = (s) => s.replace(/([\\%_])/g, '\\$1');

export function toNote(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: row.tags || [],
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ''));
}

export function createNotesRepo({ pool }) {
  const repo = {
    async list({ kind, tag, q, limit, cursor } = {}) {
      const take = clampLimit(limit);
      const params = [];
      const bind = (value) => {
        params.push(value);
        return `$${params.length}`;
      };

      const where = [];
      if (kind) where.push(`kind = ${bind(kind)}`);
      if (tag) where.push(`tags @> ARRAY[${bind(tag)}]::text[]`);

      const term = String(q ?? '').trim();
      if (term) {
        const tsquery = bind(term);
        const pattern = bind(`%${escapeLike(term)}%`);
        where.push(
          `(search @@ websearch_to_tsquery('simple', ${tsquery})` +
          ` OR title ILIKE ${pattern} OR body ILIKE ${pattern})`,
        );
      }

      const decoded = decodeCursor(cursor);
      if (decoded) {
        const stamp = bind(decoded.updatedAt);
        const id = bind(decoded.id);
        where.push(`(updated_at, id) < (${stamp}::timestamptz, ${id}::uuid)`);
      }

      const sql = [
        `SELECT ${COLUMNS} FROM notes`,
        where.length ? `WHERE ${where.join(' AND ')}` : '',
        `ORDER BY updated_at DESC, id DESC`,
        `LIMIT ${bind(take + 1)}`,
      ].filter(Boolean).join(' ');

      const { rows } = await pool.query(sql, params);
      const more = rows.length > take;
      const page = more ? rows.slice(0, take) : rows;
      return {
        items: page.map(toNote),
        nextCursor: more ? encodeCursor(toNote(page[page.length - 1])) : null,
      };
    },

    async get(id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM notes WHERE id = $1::uuid`, [id],
      );
      return rows[0] ? toNote(rows[0]) : null;
    },

    async create({ kind = 'note', title = '', body = '', tags = [], metadata = {} } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO notes (kind, title, body, tags, metadata)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [kind, title, body, tags, metadata],
      );
      return toNote(rows[0]);
    },

    /** An empty patch is a no-op, not an error: the note comes back unchanged. */
    async update(id, patch = {}) {
      if (!isUuid(id)) return null;

      const params = [];
      const bind = (value) => {
        params.push(value);
        return `$${params.length}`;
      };
      const sets = PATCHABLE
        .filter((field) => patch[field] !== undefined)
        .map((field) => `${field} = ${bind(patch[field])}`);

      if (sets.length === 0) return repo.get(id);

      const idParam = bind(id);
      const { rows } = await pool.query(
        `UPDATE notes SET ${sets.join(', ')} WHERE id = ${idParam}::uuid RETURNING ${COLUMNS}`,
        params,
      );
      return rows[0] ? toNote(rows[0]) : null;
    },

    async remove(id) {
      if (!isUuid(id)) return false;
      const { rowCount } = await pool.query('DELETE FROM notes WHERE id = $1::uuid', [id]);
      return rowCount > 0;
    },

    async counts() {
      const { rows } = await pool.query('SELECT kind, count(*)::int AS count FROM notes GROUP BY kind');
      const counts = Object.fromEntries(rows.map((r) => [r.kind, r.count]));
      const total = rows.reduce((sum, r) => sum + r.count, 0);
      return { counts, total };
    },
  };

  return repo;
}
