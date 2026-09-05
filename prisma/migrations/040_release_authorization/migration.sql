BEGIN;
ALTER TABLE "review_revisions" ADD COLUMN IF NOT EXISTS "source_fingerprint" VARCHAR(64);
COMMIT;
BEGIN;
CREATE TABLE IF NOT EXISTS "release_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "provider" VARCHAR(30) NOT NULL DEFAULT 'GITHUB',
  "repository_owner" VARCHAR(255) NOT NULL,
  "repository_name" VARCHAR(255) NOT NULL,
  "pull_request_number" INTEGER NOT NULL,
  "base_ref" VARCHAR(255) NOT NULL,
  "head_sha" CHAR(40) NOT NULL,
  "target_environment" VARCHAR(30) NOT NULL DEFAULT 'PRODUCTION',
  "release_policy_id" VARCHAR(160) NOT NULL,
  "source_fingerprint" CHAR(64) NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'PREPARING',
  "authorization_decision_record_id" UUID,
  "version" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(100),
  "last_error" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "release_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_release_runs_scope_fingerprint" UNIQUE ("workspace_id", "provider", "repository_owner", "repository_name", "pull_request_number", "source_fingerprint"),
  CONSTRAINT "idx_release_runs_authorization_decision" UNIQUE ("authorization_decision_record_id")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "release_run_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "release_run_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "release_run_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_release_run_tasks_run_task" UNIQUE ("release_run_id", "task_id")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "release_dispatches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "release_run_id" UUID NOT NULL,
  "decision_record_id" UUID NOT NULL,
  "continuation_key" VARCHAR(80) NOT NULL DEFAULT 'DISPATCH_RELEASE_RUN',
  "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  "idempotency_key" VARCHAR(255) NOT NULL,
  "claimed_by" VARCHAR(255),
  "claim_expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "runtime_run_id" VARCHAR(255),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "release_dispatches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idx_release_dispatches_decision_continuation" UNIQUE ("decision_record_id", "continuation_key"),
  CONSTRAINT "idx_release_dispatches_idempotency" UNIQUE ("idempotency_key")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_review_revisions_request_source" ON "review_revisions" ("request_id", "source_fingerprint");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_release_runs_workspace_state" ON "release_runs" ("workspace_id", "state", "updated_at");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_release_runs_repository_pr" ON "release_runs" ("provider", "repository_owner", "repository_name", "pull_request_number");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_release_run_tasks_task_run" ON "release_run_tasks" ("task_id", "release_run_id");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_release_dispatches_claim" ON "release_dispatches" ("status", "claim_expires_at", "created_at");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "idx_release_dispatches_run_status" ON "release_dispatches" ("release_run_id", "status");
COMMIT;
