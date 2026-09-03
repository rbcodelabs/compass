BEGIN;
CREATE TABLE IF NOT EXISTS "portfolio_capacity_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "policy_id" VARCHAR(160) NOT NULL,
  "plan_fingerprint" CHAR(64) NOT NULL,
  "unit" VARCHAR(80) NOT NULL,
  "available_units" INTEGER NOT NULL,
  "units_per_now_item" INTEGER NOT NULL,
  "now_limit" INTEGER NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  "active_workspace_id" UUID,
  "now_snapshot_fingerprint" CHAR(64),
  "now_snapshot_count" INTEGER,
  "reconciled_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "portfolio_capacity_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_capacity_plans_workspace_policy" UNIQUE ("workspace_id", "policy_id"),
  CONSTRAINT "idx_capacity_plans_active_workspace" UNIQUE NULLS DISTINCT ("active_workspace_id"),
  CONSTRAINT "chk_capacity_plans_active_claim" CHECK (
    (state = 'ACTIVE' AND active_workspace_id = workspace_id)
    OR (state <> 'ACTIVE' AND active_workspace_id IS NULL)
  )
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "portfolio_capacity_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_id" UUID NOT NULL,
  "roadmap_item_id" UUID NOT NULL,
  "active_roadmap_item_id" UUID,
  "decision_record_id" UUID,
  "units" INTEGER NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'STAGED',
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "portfolio_capacity_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_capacity_reservations_plan_item" UNIQUE ("plan_id", "roadmap_item_id"),
  CONSTRAINT "idx_capacity_reservations_active_item" UNIQUE NULLS DISTINCT ("active_roadmap_item_id"),
  CONSTRAINT "chk_capacity_reservations_state_claim" CHECK (
    (state = 'STAGED' AND active_roadmap_item_id IS NULL AND released_at IS NULL)
    OR (state = 'ACTIVE' AND active_roadmap_item_id = roadmap_item_id AND released_at IS NULL)
    OR (state = 'RELEASED' AND active_roadmap_item_id IS NULL AND released_at IS NOT NULL)
  )
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "portfolio_capacity_operations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "plan_id" UUID,
  "action" VARCHAR(20) NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "request_fingerprint" CHAR(64) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'IN_PROGRESS',
  "progress_cursor" UUID,
  "result_json" TEXT,
  "error_code" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "portfolio_capacity_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_capacity_operations_workspace_key" UNIQUE ("workspace_id", "idempotency_key")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_plans_workspace_state" ON "portfolio_capacity_plans" ("workspace_id", "state");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_reservations_plan_state" ON "portfolio_capacity_reservations" ("plan_id", "state");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_reservations_item_history" ON "portfolio_capacity_reservations" ("roadmap_item_id", "created_at");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_reservations_decision" ON "portfolio_capacity_reservations" ("decision_record_id");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_operations_plan_action_created" ON "portfolio_capacity_operations" ("plan_id", "action", "created_at");
COMMIT;
