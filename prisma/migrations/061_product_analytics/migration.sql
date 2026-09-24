-- Additive analytics data; no foreign keys (application-scoped integrity).
CREATE TABLE IF NOT EXISTS "analytics_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "project_id" VARCHAR(255) NOT NULL,
  "team_id" VARCHAR(255),
  "secret_encrypted" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "health" VARCHAR(40) NOT NULL DEFAULT 'CONNECTED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "metric_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "current_revision_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "metric_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "metric_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "unit" VARCHAR(80) NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "connection_id" UUID,
  "query_json" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "metric_bindings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "metric_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "target_type" VARCHAR(30) NOT NULL,
  "target_id" UUID NOT NULL,
  "baseline_json" TEXT NOT NULL,
  "followup_json" TEXT NOT NULL,
  "target_value" DOUBLE PRECISION,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "last_error" VARCHAR(80),
  "last_attempt_at" TIMESTAMP(3),
  "last_attempt_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "metric_observations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "binding_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "refresh_key" VARCHAR(64) NOT NULL,
  "window_kind" VARCHAR(12) NOT NULL,
  "snapshot_json" TEXT NOT NULL,
  "data_json" TEXT NOT NULL,
  "retrieved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "workspace_activation_states" (
  "workspace_id" UUID NOT NULL PRIMARY KEY,
  "collection_started_at" TIMESTAMP(3) NOT NULL,
  "discovery_at" TIMESTAMP(3),
  "delivery_at" TIMESTAMP(3),
  "learning_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_analytics_connection_workspace_provider" ON "analytics_connections" ("workspace_id", "provider");
CREATE INDEX ASYNC IF NOT EXISTS "idx_metric_definition_workspace" ON "metric_definitions" ("workspace_id", "archived");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_metric_revision_number" ON "metric_revisions" ("metric_id", "revision");
CREATE INDEX ASYNC IF NOT EXISTS "idx_metric_revision_workspace" ON "metric_revisions" ("workspace_id", "connection_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_metric_binding_target" ON "metric_bindings" ("workspace_id", "target_type", "target_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_metric_binding_metric" ON "metric_bindings" ("workspace_id", "metric_id");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_metric_observation_refresh" ON "metric_observations" ("refresh_key");
CREATE INDEX ASYNC IF NOT EXISTS "idx_metric_observation_binding" ON "metric_observations" ("workspace_id", "binding_id", "retrieved_at");
