-- Additive persistence for the application-authoritative research voice control
-- plane. The migration runner executes each statement in its own transaction.

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS voice_attempt_count INTEGER;

ALTER TABLE research_sessions ALTER COLUMN voice_attempt_count SET DEFAULT 0;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS voice_turn_count INTEGER;

ALTER TABLE research_sessions ALTER COLUMN voice_turn_count SET DEFAULT 0;

ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS voice_transcript_chars INTEGER;

ALTER TABLE research_sessions ALTER COLUMN voice_transcript_chars SET DEFAULT 0;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS voice_window_at TIMESTAMPTZ;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS voice_count INTEGER;

ALTER TABLE research_participant_tokens ALTER COLUMN voice_count SET DEFAULT 0;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS voice_day_at TIMESTAMPTZ;

ALTER TABLE research_participant_tokens ADD COLUMN IF NOT EXISTS voice_day_count INTEGER;

ALTER TABLE research_participant_tokens ALTER COLUMN voice_day_count SET DEFAULT 0;

CREATE TABLE research_voice_calls (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID NOT NULL, participant_token_id UUID NOT NULL, idempotency_key VARCHAR(128) NOT NULL, offer_sha256 VARCHAR(64) NOT NULL, answer_sdp TEXT, provider_call_id VARCHAR(255), sandbox_name VARCHAR(255), sandbox_command_id VARCHAR(255), worker_token_hash VARCHAR(64) NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'PROVISIONING', attempt_number INTEGER NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL, last_heartbeat_at TIMESTAMPTZ, status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(), connected_at TIMESTAMPTZ, ended_at TIMESTAMPTZ, last_provider_event_id VARCHAR(255), next_provider_ordinal INTEGER NOT NULL DEFAULT 0, last_provider_item_id VARCHAR(255), end_reason VARCHAR(50), error_code VARCHAR(50), transcript_integrity VARCHAR(20) NOT NULL DEFAULT 'PENDING', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE UNIQUE INDEX ASYNC idx_research_voice_calls_session_key ON research_voice_calls (session_id, idempotency_key);

CREATE UNIQUE INDEX ASYNC idx_research_voice_calls_provider_call ON research_voice_calls (provider_call_id);

CREATE UNIQUE INDEX ASYNC idx_research_voice_calls_worker_token ON research_voice_calls (worker_token_hash);

CREATE INDEX ASYNC idx_research_voice_calls_session_status ON research_voice_calls (session_id, status);

CREATE INDEX ASYNC idx_research_voice_calls_status_lease ON research_voice_calls (status, lease_expires_at);

CREATE INDEX ASYNC idx_research_voice_calls_status_heartbeat ON research_voice_calls (status, last_heartbeat_at);

CREATE INDEX ASYNC idx_research_voice_calls_participant_token ON research_voice_calls (participant_token_id);

CREATE TABLE research_voice_commands (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), voice_call_id UUID NOT NULL, session_id UUID NOT NULL, idempotency_key VARCHAR(128) NOT NULL, kind VARCHAR(30) NOT NULL, attachment_id UUID, status VARCHAR(20) NOT NULL DEFAULT 'PENDING', attempt_count INTEGER NOT NULL DEFAULT 0, claim_expires_at TIMESTAMPTZ, error_code VARCHAR(50), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE UNIQUE INDEX ASYNC idx_research_voice_commands_call_key ON research_voice_commands (voice_call_id, idempotency_key);

CREATE INDEX ASYNC idx_research_voice_commands_call_status_created ON research_voice_commands (voice_call_id, status, created_at);

CREATE INDEX ASYNC idx_research_voice_commands_session ON research_voice_commands (session_id);

ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS voice_call_id UUID;

ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS provider_item_id VARCHAR(255);

ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS provider_response_id VARCHAR(255);

ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS provider_previous_item_id VARCHAR(255);

ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS provider_ordinal INTEGER;

ALTER TABLE research_voice_events ADD COLUMN IF NOT EXISTS provider_status VARCHAR(30);

CREATE UNIQUE INDEX ASYNC idx_research_voice_events_call_provider ON research_voice_events (voice_call_id, provider_event_id);

CREATE UNIQUE INDEX ASYNC idx_research_voice_events_call_ordinal ON research_voice_events (voice_call_id, provider_ordinal);

CREATE UNIQUE INDEX ASYNC idx_research_voice_events_call_item ON research_voice_events (voice_call_id, provider_item_id);
