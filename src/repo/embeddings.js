/**
 * Vectors, one row per (note, model). The dimension lives in its own column and
 * is enforced by a check constraint, so a corpus can never silently mix two
 * models' spaces: switching models simply writes a second row.
 */
import { isUuid } from './notes.js';

/** pgvector takes the array as a literal, e.g. '[0.1,0.2]'. */
export const toVectorLiteral = (vector) => `[${vector.map((n) => Number(n)).join(',')}]`;

export function createEmbeddingsRepo({ pool }) {
  return {
    async upsert({ noteId, model, vector }) {
      const { rows } = await pool.query(
        `INSERT INTO note_embeddings (note_id, model, dim, embedding)
         VALUES ($1::uuid, $2, $3, $4::vector)
         ON CONFLICT (note_id, model) DO UPDATE
            SET embedding = EXCLUDED.embedding,
                dim = EXCLUDED.dim,
                created_at = clock_timestamp()
         RETURNING note_id, model, dim, created_at`,
        [noteId, model, vector.length, toVectorLiteral(vector)],
      );
      const row = rows[0];
      return { noteId: row.note_id, model: row.model, dim: row.dim, createdAt: row.created_at };
    },

    async get(noteId, model) {
      if (!isUuid(noteId)) return null;
      const { rows } = await pool.query(
        'SELECT note_id, model, dim, created_at FROM note_embeddings WHERE note_id = $1::uuid AND model = $2',
        [noteId, model],
      );
      if (!rows[0]) return null;
      return { noteId: rows[0].note_id, model: rows[0].model, dim: rows[0].dim, createdAt: rows[0].created_at };
    },

    async count() {
      const { rows } = await pool.query('SELECT model, count(*)::int AS count FROM note_embeddings GROUP BY model');
      return rows.map((r) => ({ model: r.model, count: r.count }));
    },

    /**
     * Nearest neighbours by cosine distance. `<=>` is pgvector's cosine
     * distance operator, so similarity is 1 - distance. Without an ANN index
     * this is a sequential scan — correct and fast enough for a personal
     * corpus, and the reason the index is a documented one-liner instead of a
     * hardcoded dimension in a migration.
     */
    async nearest({ model, vector, excludeNoteId = null, limit = 5 }) {
      const { rows } = await pool.query(
        `SELECT n.id, n.kind, n.title, n.body,
                1 - (e.embedding <=> $1::vector) AS similarity
           FROM note_embeddings e
           JOIN notes n ON n.id = e.note_id
          WHERE e.model = $2
            AND ($3::uuid IS NULL OR e.note_id <> $3::uuid)
          ORDER BY e.embedding <=> $1::vector, n.id
          LIMIT $4`,
        [toVectorLiteral(vector), model, excludeNoteId, Math.max(1, Math.min(limit, 50))],
      );

      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        snippet: String(r.body ?? '').slice(0, 200),
        similarity: Number(r.similarity),
      }));
    },
  };
}
