-- Custom field inheritance rules (ADR: Custom field inheritance rules, TASK-101). Purely additive.
-- One new table plus three async indexes; no data writes, no backfill.
-- DSQL: no foreign keys (application-scoped integrity), no triggers, no partial or DESC indexes, no ALTERs.
-- Postgres / Supabase: the runner rewrites "INDEX ASYNC" to "INDEX" when usesPlainPostgres() is true.
-- The code treats a missing table as "no rules", so code and migration can ship in either order.
CREATE TABLE IF NOT EXISTS "custom_field_inheritance_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "workspace_id" UUID NOT NULL,
  "target_object_type" VARCHAR(50) NOT NULL,
  "target_field_id" UUID NOT NULL,
  "source_object_type" VARCHAR(50) NOT NULL,
  "source_field_id" UUID NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "source" VARCHAR(20) NOT NULL DEFAULT 'UI'
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_cfir_target_priority" ON "custom_field_inheritance_rules" ("workspace_id", "target_field_id", "priority");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_cfir_target_source" ON "custom_field_inheritance_rules" ("workspace_id", "target_field_id", "source_field_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_cfir_workspace_target_type" ON "custom_field_inheritance_rules" ("workspace_id", "target_object_type");
