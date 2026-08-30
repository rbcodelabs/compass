-- Migration 036: harden public research capture without altering the shipped
-- 034/035 migrations. Aurora DSQL requires one DDL statement per transaction;
-- the migration runner executes each semicolon-delimited statement separately.

CREATE TABLE research_participant_tokens (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), study_id UUID NOT NULL, token_hash VARCHAR(64) NOT NULL, kind VARCHAR(30) NOT NULL DEFAULT 'PRIMARY', expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by_id UUID);

INSERT INTO research_participant_tokens (study_id, token_hash, kind, expires_at, created_at, created_by_id) SELECT id, share_token_hash, 'PRIMARY', share_expires_at, created_at, created_by_id FROM research_studies WHERE share_token_hash IS NOT NULL AND share_expires_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_participant_tokens WHERE research_participant_tokens.token_hash = research_studies.share_token_hash);

CREATE UNIQUE INDEX ASYNC idx_research_participant_tokens_hash ON research_participant_tokens (token_hash);

CREATE INDEX ASYNC idx_research_participant_tokens_study_kind ON research_participant_tokens (study_id, kind, revoked_at);

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS start_window_at TIMESTAMPTZ;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS start_count INTEGER;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS response_window_at TIMESTAMPTZ;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS response_count INTEGER;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS agent_window_at TIMESTAMPTZ;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS agent_call_count INTEGER;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS participant_token_id UUID;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS resume_token_hash VARCHAR(64);

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS ended_reason VARCHAR(50);

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS next_sequence INTEGER;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS active_request_id UUID;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS active_request_expires_at TIMESTAMPTZ;

UPDATE research_sessions SET next_sequence = COALESCE((SELECT MAX(sequence) + 1 FROM research_turns WHERE research_turns.session_id = research_sessions.id), 0) WHERE next_sequence IS NULL;

CREATE UNIQUE INDEX ASYNC idx_research_sessions_resume_token ON research_sessions (resume_token_hash);

CREATE INDEX ASYNC idx_research_sessions_participant_token ON research_sessions (participant_token_id, status);

CREATE TABLE research_requests (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID NOT NULL, idempotency_key VARCHAR(128) NOT NULL, participant_turn_id UUID, interviewer_turn_id UUID, status VARCHAR(20) NOT NULL DEFAULT 'PROCESSING', error_code VARCHAR(50), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE UNIQUE INDEX ASYNC idx_research_requests_session_key ON research_requests (session_id, idempotency_key);

CREATE INDEX ASYNC idx_research_requests_session_created ON research_requests (session_id, created_at);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
