-- The derived side: everything a model produced, kept apart from the note it
-- is about. Regenerating an insight inserts a new row; it never edits `notes`.
-- `accepted_at` / `dismissed_at` are the person's verdict on it — a suggestion
-- is not a fact until someone says so.
CREATE TABLE IF NOT EXISTS derived_items (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id      uuid        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    kind         text        NOT NULL,
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    provider     text        NOT NULL DEFAULT '',
    model        text        NOT NULL DEFAULT '',
    generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    accepted_at  timestamptz,
    dismissed_at timestamptz,
    CONSTRAINT derived_items_kind_check CHECK (kind IN (
        'tag_suggestion', 'summary', 'related', 'pulse_connection'
    )),
    -- A verdict is one thing: accepted or dismissed, never both.
    CONSTRAINT derived_items_verdict_check CHECK (
        NOT (accepted_at IS NOT NULL AND dismissed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS derived_items_note_idx
    ON derived_items (note_id, kind, generated_at DESC);

-- Which lineage is still outstanding, per note: the query the UI asks.
CREATE INDEX IF NOT EXISTS derived_items_open_idx
    ON derived_items (note_id, generated_at DESC)
    WHERE accepted_at IS NULL AND dismissed_at IS NULL;
