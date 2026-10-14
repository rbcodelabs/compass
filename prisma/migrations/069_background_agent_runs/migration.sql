-- Durable, detachable agent runs. Purely additive — no existing table
-- is altered, so a deployment that has not yet applied this migration keeps
-- working on the synchronous turn path (see lib/agent-runs.ts fallback).
-- DSQL: no foreign keys (application-scoped integrity), no JSON columns.
CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "conversation_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  "kind" VARCHAR(30) NOT NULL DEFAULT 'CHAT',
  "worker_token_hash" VARCHAR(64) NOT NULL,
  "api_key_id" UUID,
  "sandbox_name" VARCHAR(255),
  "sandbox_stopped_at" TIMESTAMP(3),
  "claim_id" UUID,
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "last_heartbeat_at" TIMESTAMP(3),
  "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "last_seq" INTEGER NOT NULL DEFAULT 0,
  "event_count" INTEGER NOT NULL DEFAULT 0,
  "payload_bytes" INTEGER NOT NULL DEFAULT 0,
  "model" VARCHAR(100),
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "num_turns" INTEGER,
  "cost_usd" DOUBLE PRECISION,
  "duration_ms" INTEGER,
  "pack_provenance" TEXT,
  "error" TEXT,
  "error_code" VARCHAR(50),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "agent_run_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "run_id" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "payload_json" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique first: callback idempotency depends on both of these. The worker-token
-- index is the authentication lookup; (run_id, seq) is what collides a retried
-- batch instead of duplicating the transcript.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_agent_runs_worker_token" ON "agent_runs" ("worker_token_hash");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_agent_run_events_run_seq" ON "agent_run_events" ("run_id", "seq");
CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_runs_conversation_created" ON "agent_runs" ("conversation_id", "created_at");
CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_runs_status_heartbeat" ON "agent_runs" ("status", "last_heartbeat_at");
CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_runs_workspace_user" ON "agent_runs" ("workspace_id", "user_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_agent_run_events_run_created" ON "agent_run_events" ("run_id", "created_at");
