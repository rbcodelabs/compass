-- Migration 034: workspace-scoped research capture
-- DSQL: no foreign keys; indexes are created asynchronously.

CREATE TABLE research_studies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, name VARCHAR(255) NOT NULL, goal TEXT NOT NULL, study_type VARCHAR(30) NOT NULL DEFAULT 'CUSTOMER_INTERVIEW', guide TEXT NOT NULL, target_minutes INTEGER NOT NULL DEFAULT 15, app_url TEXT, share_token_hash VARCHAR(64), share_expires_at TIMESTAMPTZ, status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by_id UUID, updated_by_id UUID, source VARCHAR(20) NOT NULL DEFAULT 'UI');

CREATE TABLE research_sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), study_id UUID NOT NULL, modality VARCHAR(10) NOT NULL DEFAULT 'CHAT', status VARCHAR(20) NOT NULL DEFAULT 'PENDING', participant_name VARCHAR(255), participant_email VARCHAR(255), summary TEXT, audio_url TEXT, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE research_turns (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), session_id UUID NOT NULL, role VARCHAR(20) NOT NULL, content TEXT NOT NULL, sequence INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE research_syntheses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), study_id UUID NOT NULL, kind VARCHAR(30) NOT NULL DEFAULT 'CROSS_SESSION', content TEXT NOT NULL, session_count INTEGER NOT NULL DEFAULT 0, model VARCHAR(100), prompt_version VARCHAR(50), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE UNIQUE INDEX ASYNC idx_research_studies_share_token ON research_studies (share_token_hash);
CREATE INDEX ASYNC idx_research_studies_workspace_status ON research_studies (workspace_id, status);
CREATE INDEX ASYNC idx_research_sessions_study_status ON research_sessions (study_id, status);
CREATE UNIQUE INDEX ASYNC idx_research_turns_session_sequence ON research_turns (session_id, sequence);
CREATE INDEX ASYNC idx_research_syntheses_study_created ON research_syntheses (study_id, created_at);
