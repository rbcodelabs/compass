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
  "version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "portfolio_capacity_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_capacity_plans_workspace_policy" UNIQUE ("workspace_id", "policy_id")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "portfolio_capacity_reservations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "plan_id" UUID NOT NULL,
  "roadmap_item_id" UUID NOT NULL,
  "decision_record_id" UUID,
  "units" INTEGER NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "portfolio_capacity_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_capacity_reservations_item" UNIQUE ("roadmap_item_id")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_plans_workspace_state" ON "portfolio_capacity_plans" ("workspace_id", "state");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_reservations_plan_state" ON "portfolio_capacity_reservations" ("plan_id", "state");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_capacity_reservations_decision" ON "portfolio_capacity_reservations" ("decision_record_id");
COMMIT;
