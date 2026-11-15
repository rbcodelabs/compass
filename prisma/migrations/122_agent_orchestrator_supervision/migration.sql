-- Migration 122: Personal Workspace/Squad Orchestrators & Conversation Supervision (Phase 4)
-- Adds `agent_orchestrators` (personal Workspace or Squad orchestrators per user + workspace) and
-- `agent_conversation_supervision` (Manager Notes v2 and human-gated ProposedReply state).
-- DSQL-compatible: no FKs, no triggers, no JSONB (TEXT), TIMESTAMP(3), and ASYNC index creation
-- with no ASC/DESC direction keywords or partial WHERE clauses.

CREATE TABLE IF NOT EXISTS "agent_orchestrators" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope_type" VARCHAR(20) NOT NULL DEFAULT 'WORKSPACE',
    "scope_key" VARCHAR(64) NOT NULL DEFAULT 'workspace',
    "conversation_id" UUID,
    "agent_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "wake_on_activity" BOOLEAN NOT NULL DEFAULT true,
    "heartbeat_enabled" BOOLEAN NOT NULL DEFAULT false,
    "heartbeat_minutes" INTEGER NOT NULL DEFAULT 60,
    "escalations_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_heartbeat_at" TIMESTAMP(3),
    "last_escalation_state_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_orchestrators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "agent_orchestrators_user_ws_scope_key"
    ON "agent_orchestrators"("user_id", "workspace_id", "scope_type", "scope_key");

CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_orchestrators_workspace_user"
    ON "agent_orchestrators"("workspace_id", "user_id");

CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_orchestrators_conversation"
    ON "agent_orchestrators"("conversation_id");

CREATE TABLE IF NOT EXISTS "agent_conversation_supervision" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "supervisor_user_id" UUID NOT NULL,
    "manager_notes" TEXT NOT NULL DEFAULT '',
    "manager_notes_updated_at" TIMESTAMP(3),
    "manager_source_orchestrator_id" UUID,
    "proposed_reply_text" TEXT,
    "proposed_reply_generated_at" TIMESTAMP(3),
    "proposed_reply_author_orchestrator_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_conversation_supervision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "agent_conversation_supervision_conv_user_key"
    ON "agent_conversation_supervision"("conversation_id", "supervisor_user_id");

CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_conversation_supervision_ws_user"
    ON "agent_conversation_supervision"("workspace_id", "supervisor_user_id");
