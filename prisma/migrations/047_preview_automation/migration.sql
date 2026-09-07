-- Every statement is applied in a separate transaction by the migration runner.
CREATE TABLE IF NOT EXISTS preview_automation_sessions (
  session_token VARCHAR(512) PRIMARY KEY,
  run_id UUID NOT NULL
);

CREATE TABLE IF NOT EXISTS preview_automation_runs (
  id UUID PRIMARY KEY,
  deployment_id VARCHAR(255) NOT NULL,
  org_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  isolated_workspace_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  viewer_user_id UUID NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  cleaned_at TIMESTAMP,
  session_nonce UUID,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS preview_automation_nonces (
  nonce UUID PRIMARY KEY,
  run_id UUID NOT NULL,
  expires_at TIMESTAMP NOT NULL
);
