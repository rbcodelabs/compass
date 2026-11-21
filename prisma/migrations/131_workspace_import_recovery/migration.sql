BEGIN;
CREATE TABLE IF NOT EXISTS "workspace_import_operations" (
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "epoch" INTEGER NOT NULL DEFAULT 1,
  "phase" VARCHAR(24) NOT NULL,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "result_text" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("workspace_id")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_workspace_import_operations_phase_lease_expires_at" ON "workspace_import_operations" ("phase", "lease_expires_at");
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "workspace_import_assets" (
  "attempt_id" UUID NOT NULL,
  "logical_key" VARCHAR(800) NOT NULL,
  "workspace_id" UUID NOT NULL,
  "backend" VARCHAR(20) NOT NULL,
  "physical_key" TEXT NOT NULL,
  "provider_id" VARCHAR(20) NOT NULL,
  "namespace_id" TEXT NOT NULL,
  "expected_bytes" BIGINT NOT NULL,
  "expected_sha256" VARCHAR(64) NOT NULL,
  "state" VARCHAR(24) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("attempt_id", "logical_key")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_workspace_import_assets_workspace_id_state" ON "workspace_import_assets" ("workspace_id", "state");
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "workspace_import_receipts" (
  "receipt_digest" VARCHAR(64) NOT NULL,
  "workspace_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "effective_nonce" VARCHAR(200) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("receipt_digest")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_workspace_import_receipts_expires_at" ON "workspace_import_receipts" ("expires_at");
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "workspace_import_required_assets" (
  "attempt_id" UUID NOT NULL,
  "logical_key" VARCHAR(800) NOT NULL,
  PRIMARY KEY ("attempt_id", "logical_key")
);
COMMIT;
