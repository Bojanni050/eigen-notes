-- The raw side. Nothing in this table is ever written by a model.
--
-- `updated_at` is owned by the database (trigger below), not by the API: any
-- writer gets the same semantics, and the keyset cursor can trust it. It uses
-- clock_timestamp() rather than now(), because now() is transaction time —
-- two notes created in one transaction would carry identical timestamps and
-- page in an unstable order.
CREATE TABLE IF NOT EXISTS notes (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text        NOT NULL DEFAULT 'note',
    title       text        NOT NULL DEFAULT '',
    body        text        NOT NULL DEFAULT '',
    tags        text[]      NOT NULL DEFAULT '{}',
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT notes_kind_check CHECK (kind IN (
        'note', 'person', 'task', 'idea', 'book', 'project', 'meeting', 'daily'
    ))
);

-- Searching is a generated column, so it can never drift from title/body.
-- 'simple' on purpose: the notes are Dutch and English mixed, and a language
-- config would silently stem the other one wrong. pg_trgm covers the rest.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))
    ) STORED;

CREATE OR REPLACE FUNCTION notes_touch() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_touch_trigger ON notes;
CREATE TRIGGER notes_touch_trigger
    BEFORE UPDATE ON notes
    FOR EACH ROW EXECUTE FUNCTION notes_touch();

CREATE INDEX IF NOT EXISTS notes_search_idx        ON notes USING gin (search);
CREATE INDEX IF NOT EXISTS notes_title_trgm_idx    ON notes USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS notes_body_trgm_idx     ON notes USING gin (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS notes_tags_idx          ON notes USING gin (tags);
CREATE INDEX IF NOT EXISTS notes_kind_updated_idx  ON notes (kind, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notes_updated_idx       ON notes (updated_at DESC, id DESC);
