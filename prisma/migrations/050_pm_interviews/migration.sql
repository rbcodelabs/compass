ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS pm_interviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  study_id UUID NOT NULL,
  session_id UUID NOT NULL,
  initiating_user_id UUID NOT NULL,
  target_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  context_snapshot_json TEXT NOT NULL,
  field_baseline_json TEXT NOT NULL,
  generation_state VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED',
  generation_claim_id UUID,
  generation_claimed_at TIMESTAMPTZ,
  generation_failure_code VARCHAR(50),
  source_fingerprint VARCHAR(64),
  proposal_json TEXT,
  disposition VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  receipt_json TEXT,
  applied_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  disposition_idempotency_key VARCHAR(128),
  retired_voice_lease_id UUID,
  transition_receipt_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_study ON pm_interviews (study_id);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_session ON pm_interviews (session_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_workspace_created ON pm_interviews (workspace_id, created_at);
CREATE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_target ON pm_interviews (workspace_id, target_type, target_id);
CREATE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_generation_claim ON pm_interviews (generation_state, generation_claimed_at);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_disposition_key ON pm_interviews (id, disposition_idempotency_key);
