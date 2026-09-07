-- Standalone durable cleanup for failed private research attachment writes.
-- The authenticated runner executes every semicolon-delimited statement independently.

CREATE TABLE research_blob_cleanups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, study_id UUID NOT NULL, session_id UUID NOT NULL, attachment_id UUID NOT NULL, blob_pathname TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ);

CREATE UNIQUE INDEX ASYNC idx_research_blob_cleanups_pathname ON research_blob_cleanups (blob_pathname);

CREATE INDEX ASYNC idx_research_blob_cleanups_workspace_retry ON research_blob_cleanups (workspace_id, status, next_attempt_at);
