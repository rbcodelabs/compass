-- Migration 123: Orchestrator Event Wake-ups & Two-Stage Debounce State Machine (Phase 5)
-- Adds `agent_orchestrator_wakeups` to durably coalesce completed/failed conversation turns across
-- a 60s quiet wait (0s on ERROR) and 12s batch window before waking an AgentOrchestrator.
-- DSQL-compatible: no FKs, no triggers, no JSONB, TIMESTAMP(3), and ASYNC index creation
-- with no ASC/DESC direction keywords or partial WHERE clauses.

CREATE TABLE IF NOT EXISTS "agent_orchestrator_wakeups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orchestrator_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "target_conversation_id" UUID NOT NULL,
    "event_status" VARCHAR(20) NOT NULL DEFAULT 'DONE',
    "target_updated_at_iso" VARCHAR(64) NOT NULL,
    "quiet_until" TIMESTAMP(3) NOT NULL,
    "flush_after" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 1,
    "busy_retries" INTEGER NOT NULL DEFAULT 0,
    "state" VARCHAR(24) NOT NULL DEFAULT 'QUIET_WAIT',
    "dispatched_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_orchestrator_wakeups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "agent_orchestrator_wakeups_orch_target_key"
    ON "agent_orchestrator_wakeups"("orchestrator_id", "target_conversation_id");

CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_orchestrator_wakeups_state_quiet"
    ON "agent_orchestrator_wakeups"("state", "quiet_until");

CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_orchestrator_wakeups_state_flush"
    ON "agent_orchestrator_wakeups"("state", "flush_after");

CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_orchestrator_wakeups_workspace_orch"
    ON "agent_orchestrator_wakeups"("workspace_id", "orchestrator_id");
