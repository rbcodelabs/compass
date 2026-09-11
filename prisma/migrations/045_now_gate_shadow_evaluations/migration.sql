BEGIN;
CREATE TABLE IF NOT EXISTS "now_gate_evaluations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "roadmap_item_id" UUID NOT NULL,
  "ingress_key" VARCHAR(64) NOT NULL,
  "mode" VARCHAR(16) NOT NULL,
  "outcome" VARCHAR(24) NOT NULL,
  "blocker_code" VARCHAR(80),
  "policy_artifact_id" VARCHAR(160),
  "routing_fingerprint" VARCHAR(71),
  "capacity_plan_id" UUID,
  "capacity_plan_fingerprint" CHAR(64),
  "source_fingerprint" CHAR(64),
  "actor_kind" VARCHAR(16) NOT NULL,
  "actor_id" UUID,
  "correlation_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "now_gate_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_now_gate_evaluations_mode" CHECK ("mode" = 'SHADOW'),
  CONSTRAINT "chk_now_gate_evaluations_outcome" CHECK (("outcome" = 'WOULD_ALLOW' AND "blocker_code" IS NULL) OR ("outcome" = 'WOULD_BLOCK' AND "blocker_code" IS NOT NULL)),
  CONSTRAINT "chk_now_gate_evaluations_actor" CHECK (("actor_kind" IN ('USER', 'SERVICE') AND "actor_id" IS NOT NULL) OR ("actor_kind" IN ('ANONYMOUS', 'SYSTEM') AND "actor_id" IS NULL))
);
COMMIT;
BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_now_gate_evaluations_workspace_created" ON "now_gate_evaluations" ("workspace_id", "created_at");
COMMIT;
BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_now_gate_evaluations_workspace_outcome_created" ON "now_gate_evaluations" ("workspace_id", "outcome", "created_at");
COMMIT;
BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_now_gate_evaluations_item_created" ON "now_gate_evaluations" ("roadmap_item_id", "created_at");
COMMIT;
