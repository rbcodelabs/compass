-- Compass guided UX attachment and voice persistence. The authenticated
-- runner executes every semicolon-delimited statement independently.

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS voice_lease_id UUID;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS voice_lease_expires_at TIMESTAMPTZ;

CREATE TABLE research_attachments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, study_id UUID NOT NULL, session_id UUID NOT NULL, turn_id UUID, kind VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING', blob_pathname TEXT NOT NULL, original_name VARCHAR(255) NOT NULL, mime_type VARCHAR(100) NOT NULL, size_bytes INTEGER NOT NULL, sha256 VARCHAR(64) NOT NULL, idempotency_key VARCHAR(128) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ready_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ);

CREATE UNIQUE INDEX ASYNC idx_research_attachments_blob_pathname ON research_attachments (blob_pathname);

CREATE UNIQUE INDEX ASYNC idx_research_attachments_session_key ON research_attachments (session_id, idempotency_key);

CREATE INDEX ASYNC idx_research_attachments_session_created ON research_attachments (session_id, created_at);

CREATE INDEX ASYNC idx_research_attachments_turn_created ON research_attachments (turn_id, created_at);

CREATE INDEX ASYNC idx_research_attachments_workspace_status ON research_attachments (workspace_id, status, created_at);

CREATE TABLE research_voice_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID NOT NULL, provider_event_id VARCHAR(255) NOT NULL, turn_id UUID, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'FINAL', created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE UNIQUE INDEX ASYNC idx_research_voice_events_session_provider ON research_voice_events (session_id, provider_event_id);

CREATE INDEX ASYNC idx_research_voice_events_session_created ON research_voice_events (session_id, created_at);
