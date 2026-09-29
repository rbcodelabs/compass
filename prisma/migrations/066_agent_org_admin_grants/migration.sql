-- Migration 066: AgentOrgAdminGrant (ADR 0020)
--
-- Adds an explicit, auditable, org-scoped grant of a narrow admin capability
-- to a specific agent. Today the only capability is "SCORING_MODEL_ADMIN"
-- (create/update/archive an org ScoringModel, and assign one to a workspace
-- via set_workspace_scoring_model). See ADR 0020 (Compass Docs — Architecture
-- Decisions) and lib/agent-access.ts (hasValidAgentOrgAdminGrant).
--
-- Only app/[orgSlug]/settings/actions.ts (session-authed, gated by
-- resolveOrgAdmin) ever writes agent_org_admin_grants — no MCP tool touches
-- this table, so no agent identity can grant or revoke its own elevation.
--
-- Also adds agent_tool_calls.agent_admin_grant_id: which grant (if any)
-- authorized a given historical call. Nullable, no default — every prior row
-- predates this capability and legitimately has none.
--
-- DSQL rules followed (matching the established pattern in 049_agent_identity
-- and 056_agent_scoped_oauth_binding):
--   - No FK constraints (relationMode = "prisma"); agentId/organizationId/
--     grantedByUserId/revokedByUserId are validated in app code, not by the DB.
--   - No DEFAULT clause on the ALTER TABLE ADD COLUMN (DSQL rejects any
--     constraint there). agent_admin_grant_id is nullable with no backfill
--     needed — NULL is the correct, permanent value for every pre-existing row.
--   - One DDL statement per (implicit) transaction.
--   - CREATE INDEX ASYNC, the only form DSQL supports; the runner rewrites
--     ASYNC away when DATABASE_URL signals local PostgreSQL.
--   - Every statement is IF NOT EXISTS, so a rerun after a timed-out async
--     index wait resumes instead of failing.

CREATE TABLE IF NOT EXISTS "agent_org_admin_grants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "capability" VARCHAR(40) NOT NULL,
  "granted_by_user_id" UUID NOT NULL,
  "revoked_at" TIMESTAMP,
  "revoked_by_user_id" UUID,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "agent_org_admin_grants_agent_id_organization_id_capability_key" ON "agent_org_admin_grants" ("agent_id", "organization_id", "capability");
CREATE INDEX ASYNC IF NOT EXISTS "agent_org_admin_grants_organization_id_capability_idx" ON "agent_org_admin_grants" ("organization_id", "capability");
ALTER TABLE "agent_tool_calls" ADD COLUMN IF NOT EXISTS "agent_admin_grant_id" UUID;
