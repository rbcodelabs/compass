-- Migration 035: workspace-scoped ephemeral MCP credentials for public research agents.
-- DSQL requires ALTER TABLE columns to be nullable with no default.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS purpose VARCHAR(30);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope_workspace_id UUID;

CREATE INDEX ASYNC idx_api_keys_purpose_workspace ON api_keys (purpose, scope_workspace_id);
