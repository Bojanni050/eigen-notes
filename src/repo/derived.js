/**
 * The derived side's SQL. The only writes are inserts (new model output) and
 * verdicts (your accept/dismiss) — there is no update path that could turn a
 * suggestion into content.
 */
import { isUuid } from './notes.js';

const COLUMNS = 'id, note_id, kind, payload, provider, model, generated_at, accepted_at, dismissed_at';

export function toDerivedItem(row) {
  return {
    id: row.id,
    noteId: row.note_id,
    kind: row.kind,
    payload: row.payload || {},
    provider: row.provider,
    model: row.model,
    generatedAt: row.generated_at,
    acceptedAt: row.accepted_at,
    dismissedAt: row.dismissed_at,
  };
}

export function createDerivedRepo({ pool }) {
  return {
    async insert({ noteId, kind, payload = {}, provider = '', model = '' }) {
      const { rows } = await pool.query(
        `INSERT INTO derived_items (note_id, kind, payload, provider, model)
         VALUES ($1::uuid, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [noteId, kind, payload, provider, model],
      );
      return toDerivedItem(rows[0]);
    },

    async listForNote(noteId, { limit = 50 } = {}) {
      if (!isUuid(noteId)) return [];
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM derived_items
         WHERE note_id = $1::uuid
         ORDER BY generated_at DESC, id DESC
         LIMIT $2`,
        [noteId, Math.max(1, Math.min(Number(limit) || 50, 200))],
      );
      return rows.map(toDerivedItem);
    },

    async get(id) {
      if (!isUuid(id)) return null;
      const { rows } = await pool.query(
        `SELECT ${COLUMNS} FROM derived_items WHERE id = $1::uuid`, [id],
      );
      return rows[0] ? toDerivedItem(rows[0]) : null;
    },

    /**
     * A verdict replaces a verdict: accepting something you dismissed earlier
     * clears the other column, so the table's own check can never be violated
     * by a change of mind.
     */
    async setVerdict(id, verdict) {
      if (!isUuid(id)) return null;
      const column = verdict === 'accept' ? 'accepted_at' : verdict === 'dismiss' ? 'dismissed_at' : null;
      if (!column) return null;

      const other = column === 'accepted_at' ? 'dismissed_at' : 'accepted_at';
      const { rows } = await pool.query(
        `UPDATE derived_items
            SET ${column} = clock_timestamp(), ${other} = NULL
          WHERE id = $1::uuid
        RETURNING ${COLUMNS}`,
        [id],
      );
      return rows[0] ? toDerivedItem(rows[0]) : null;
    },
  };
}
