-- Migration 101: default agent selection
-- (ADR "Cloud agents as first-class identities", phase 3: management UI, defaults, pickers).
--
-- Additive and behavior-neutral: two new tables, nothing reads them until a default is set.
--
--   workspace_default_agents  one row per workspace: the agent a run uses when nobody chose one
--   user_default_agents       one row per (user, workspace): a personal override of the workspace default
--
-- Resolution (lib/agent-defaults.ts): explicit pick > user default > workspace default > the built-in
-- "Compass Agent". A row that points at an agent which is gone, suspended, no longer granted in the
-- workspace, or not invokable by the user is ignored at read time (it falls through to the next level),
-- so nothing here has to be cleaned up when an agent is suspended or a grant is revoked.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: every *_id column is a bare UUID validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Uniqueness comes from CREATE UNIQUE INDEX ASYNC (no ON CONFLICT is relied on; the app upserts by find-then-write).
--   - Indexes are ASYNC, with no ASC/DESC and no partial index.
--   - No trigger: updated_at is set by the application on every write.
--
-- Code that reads or writes these tables tolerates this migration being unapplied
-- (lib/agent-defaults.ts treats a missing table as "no default").

CREATE TABLE IF NOT EXISTS workspace_default_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  set_by_user_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS workspace_default_agents_workspace_id_key ON workspace_default_agents(workspace_id);

CREATE TABLE IF NOT EXISTS user_default_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS user_default_agents_user_id_workspace_id_key ON user_default_agents(user_id, workspace_id);
