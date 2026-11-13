-- Vectors, one row per model. The column is dimension-less on purpose:
-- switching embedding models must be a config change, not a migration. The
-- price is that the ANN index can only be built once the column has a
-- dimension, so the index is attempted and skipped with a notice instead of
-- failing the install — the primary key still enforces one vector per model,
-- and a sequential scan over a personal corpus is not a problem worth a
-- broken first run.
CREATE TABLE IF NOT EXISTS note_embeddings (
    note_id    uuid        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    model      text        NOT NULL,
    dim        integer     NOT NULL,
    embedding  vector      NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (note_id, model),
    CONSTRAINT note_embeddings_dim_check CHECK (vector_dims(embedding) = dim)
);

DO $$
BEGIN
    CREATE INDEX IF NOT EXISTS note_embeddings_hnsw_idx
        ON note_embeddings USING hnsw (embedding vector_cosine_ops);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'skipped the vector index (%): the column has no fixed dimension', SQLERRM;
END;
$$;
