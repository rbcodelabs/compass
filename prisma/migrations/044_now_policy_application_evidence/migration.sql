BEGIN;
CREATE TABLE IF NOT EXISTS "now_policy_application_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "application_receipt_id" UUID NOT NULL,
  "policy_artifact_id" VARCHAR(160) NOT NULL,
  "policy_payload_hash" CHAR(64) NOT NULL,
  "activation_decision_id" UUID NOT NULL,
  "activation_application_receipt_id" UUID NOT NULL,
  "activation_decision_checksum" CHAR(64) NOT NULL,
  "selector_mode" VARCHAR(20) NOT NULL,
  "selector_signature" TEXT NOT NULL,
  "signing_key_id" VARCHAR(160) NOT NULL,
  "routing_fingerprint" VARCHAR(71) NOT NULL,
  "capacity_plan_id" UUID NOT NULL,
  "capacity_plan_fingerprint" CHAR(64) NOT NULL,
  "capacity_plan_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "now_policy_application_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_now_policy_evidence_receipt" UNIQUE ("application_receipt_id")
);
COMMIT;
BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_now_policy_evidence_workspace_created" ON "now_policy_application_evidence" ("workspace_id", "created_at");
COMMIT;
