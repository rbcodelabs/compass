-- Migration 098: agent kind and workspace ownership
-- (ADR "Cloud agents as first-class identities", PR1 of 4).
--
-- Additive and behavior-neutral: six nullable columns on agents, one async index, and
-- agents.owner_user_id becomes nullable. No backfill. A row with a NULL kind reads as
-- EXTERNAL and a NULL owner_type reads as USER (lib/agent-ownership.ts), so every existing
-- agent keeps behaving exactly as before and the code ships before this is applied.
--
--   kind               EXTERNAL (key based, e.g. Geode) | CLOUD (sandbox run)
--   owner_type         USER | WORKSPACE; owner_user_id / owner_workspace_id carry the owner
--   owner_workspace_id set only for WORKSPACE-owned agents
--   instructions       system prompt for CLOUD agents
--   model              nullable = system default
--   invoke_policy      WORKSPACE_MEMBERS | ADMINS | OWNER; NULL = default for the owner type
--
-- Aurora DSQL rules followed:
--   - No foreign keys: owner_workspace_id is a bare UUID validated in application code.
--   - ADD COLUMN carries no DEFAULT and no NOT NULL (DSQL rejects any constraint on it).
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS / no-op when repeated).
--   - The index is CREATE INDEX ASYNC, with no ASC/DESC and no partial index.
--   - ALTER COLUMN ... DROP NOT NULL is in DSQL's documented ALTER TABLE syntax (migration 070
--     relies on the same statement) but has not been exercised on a live DSQL cluster from this
--     repo. The postcondition in lib/migrations/agent-kind-and-workspace-owner.ts proves the
--     catalog really changed before the receipt is recorded, so a DSQL that refuses it fails
--     loudly. Nothing in this release creates a WORKSPACE-owned agent, so a failure here blocks
--     only the receipt, never a request.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS kind VARCHAR(20);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_type VARCHAR(20);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_workspace_id UUID;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS instructions TEXT;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS model VARCHAR(100);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS invoke_policy VARCHAR(30);

ALTER TABLE agents ALTER COLUMN owner_user_id DROP NOT NULL;

CREATE INDEX ASYNC IF NOT EXISTS agents_owner_workspace_id_idx ON agents(owner_workspace_id);
