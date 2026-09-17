-- Migration 054: agent access requests
--
-- Self-service workspace access requests for agents (Compass solution
-- 538d6df0), the self-serve counterpart to the admin-only AgentWorkspaceGrant
-- created in 049_agent_identity. An agent owner who is already a
-- WorkspaceMember can ask for READ/WRITE access instead of asking an admin
-- to create the grant blind; admins approve/deny from WorkspaceAgentsPanel,
-- and approval upserts the same AgentWorkspaceGrant row grantWorkspaceAgent
-- already writes -- no second grant pathway.
--
-- DSQL rules followed:
--   - UUID PK via gen_random_uuid(), no SERIAL.
--   - No FK constraints -- relationMode=prisma, validated in app code, same
--     as every other Agent* table.
--   - No @updatedAt -- updated_at is set explicitly in app code.
--   - Deliberately NO unique constraint on (agent_id, workspace_id) or
--     (agent_id, workspace_id, status): a DENIED request must not block a
--     future request for the same agent+workspace. "No duplicate PENDING
--     request" is enforced in application code (requestAgentAccess), not
--     the database.
--   - Indexes are ASYNC, the only form DSQL supports. The runner rewrites
--     ASYNC away when DATABASE_URL signals local PostgreSQL.
--   - Each statement below runs in its own transaction per the runner.
--
-- Index rationale: (agent_id, workspace_id, status) backs the app-layer
-- duplicate-PENDING-request check on every requestAgentAccess call.
-- (workspace_id, status) backs WorkspaceAgentsPanel's "pending requests for
-- this workspace" listing, queried on every settings page render.

CREATE TABLE IF NOT EXISTS agent_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  requested_access VARCHAR(10) NOT NULL CHECK (requested_access IN ('READ', 'WRITE')),
  requested_by_user_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DENIED')),
  decided_by_user_id UUID,
  decided_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_access_requests_agent_workspace_status ON agent_access_requests (agent_id, workspace_id, status);

CREATE INDEX ASYNC IF NOT EXISTS idx_agent_access_requests_workspace_status ON agent_access_requests (workspace_id, status);
