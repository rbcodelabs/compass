CREATE TABLE IF NOT EXISTS "agents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'SUSPENDED')),
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ASYNC IF NOT EXISTS "agents_owner_user_id_idx" ON "agents" ("owner_user_id");
CREATE TABLE IF NOT EXISTS "agent_workspace_grants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "access" VARCHAR(10) NOT NULL CHECK ("access" IN ('READ', 'WRITE')),
  "granted_by_user_id" UUID NOT NULL,
  "revoked_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "agent_workspace_grants_agent_id_workspace_id_key" ON "agent_workspace_grants" ("agent_id", "workspace_id");
CREATE INDEX ASYNC IF NOT EXISTS "agent_workspace_grants_workspace_id_idx" ON "agent_workspace_grants" ("workspace_id");
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "agent_id" UUID;
CREATE INDEX ASYNC IF NOT EXISTS "api_keys_agent_id_idx" ON "api_keys" ("agent_id");
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "assignee_agent_id" UUID;
CREATE INDEX ASYNC IF NOT EXISTS "tasks_assignee_agent_id_idx" ON "tasks" ("assignee_agent_id");
CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "credential_id" UUID NOT NULL,
  "tool_name" VARCHAR(100) NOT NULL,
  "workspace_id" UUID,
  "status" VARCHAR(20) NOT NULL DEFAULT 'STARTED' CHECK ("status" IN ('STARTED', 'SUCCEEDED', 'DENIED', 'FAILED')),
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP
);
CREATE INDEX ASYNC IF NOT EXISTS "agent_tool_calls_agent_id_created_at_idx" ON "agent_tool_calls" ("agent_id", "created_at");
CREATE INDEX ASYNC IF NOT EXISTS "agent_tool_calls_workspace_id_created_at_idx" ON "agent_tool_calls" ("workspace_id", "created_at");
