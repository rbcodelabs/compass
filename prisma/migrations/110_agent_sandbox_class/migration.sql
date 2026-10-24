-- Migration 110: developer sandbox class for cloud agents.
-- Additive: two nullable columns and one new table. No backfill: NULL reads as "standard" for
-- agents.sandbox_class and as "off" for workspaces.agent_developer_sandbox_enabled, so the code can
-- ship before this is applied.
--
-- agents.sandbox_class: STANDARD | DEVELOPER. Which Vercel Sandbox snapshot an agent's runs boot from.
-- workspaces.agent_developer_sandbox_enabled: admin opt-in that lets agents in the workspace use DEVELOPER.
-- agent_runtime_snapshots: one row per sandbox class holding its current snapshot. The DEVELOPER row
-- records base_snapshot_id (the STANDARD snapshot it was layered on) so a base rebuild marks it stale.
-- agent_runtime_config stays as the STANDARD source of truth until a later migration moves it.
--
-- Aurora DSQL rules followed: no foreign keys, one idempotent DDL statement per statement,
-- CREATE UNIQUE INDEX ASYNC with no ASC/DESC and no partial index, no trigger and no @updatedAt.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_class VARCHAR(20);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_developer_sandbox_enabled BOOLEAN;

CREATE TABLE IF NOT EXISTS agent_runtime_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_class VARCHAR(20) NOT NULL,
  snapshot_id VARCHAR(255),
  deps_fingerprint VARCHAR(64),
  base_snapshot_id VARCHAR(255),
  snapshot_built_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_agent_runtime_snapshots_class ON agent_runtime_snapshots(sandbox_class);
