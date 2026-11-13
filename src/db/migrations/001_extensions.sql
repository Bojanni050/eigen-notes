-- Extensions. pg_trgm buys substring/fuzzy matching next to full-text search;
-- vector is what makes `related` a database query instead of "send every note
-- to a model and hope".
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
