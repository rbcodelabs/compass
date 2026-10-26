-- Migration 110: Workspace BYOK Anthropic API key (TASK-89)
--
-- Two nullable TEXT columns on workspaces: the AES-256-GCM ciphertext of the key an admin stored (lib/crypto-secrets.ts, same
-- scheme as sso_secret_encrypted) and its last four characters for display. NULL means the workspace uses the platform key.
-- Plain ADD COLUMN, no default, no constraint, no index, no foreign key, IF NOT EXISTS for idempotent reruns (DSQL rules, see 055).

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS anthropic_api_key_encrypted TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS anthropic_api_key_last4 TEXT;
