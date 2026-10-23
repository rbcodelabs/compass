-- Migration 105: workspace modules (docs/adr-workspace-modules.md).
--
-- Replaces env-var product-feature flags (COMPASS_RESEARCH_CAPTURE_ENABLED, ...) with a per-workspace, admin-toggleable
-- "module" capability. One row per (workspace, module_key); NO row means the registry default (lib/modules/registry.ts), so adding a
-- module later needs no migration. module_key is free text validated in application code.
--
-- Data: the runner hook (lib/migrations/workspace-modules.ts) folds workspaces.launch_workflow_enabled into a launch_workflow row for
-- every workspace that has it on (insert-if-missing, idempotent). The legacy column is NOT dropped and stays readable until a
-- follow-up migration removes it. The env-flag backfill is the separate, explicit-only 106_workspace_modules_legacy_flag_backfill.
--
-- Aurora DSQL rules followed:
--   - UUID PK via gen_random_uuid(); no foreign keys (workspace_id and updated_by_user_id are validated in application code).
--   - One DDL statement per transaction, each idempotent (IF NOT EXISTS).
--   - Uniqueness from CREATE UNIQUE INDEX ASYNC (no ON CONFLICT is relied on; the app and the backfill find-then-write).
--   - No trigger: updated_at is set by the application on every write.
--
-- Code reading this table tolerates this migration being unapplied (fail closed; see lib/modules/server.ts).

CREATE TABLE IF NOT EXISTS workspace_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  module_key VARCHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_by_user_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS workspace_modules_workspace_id_module_key_key ON workspace_modules(workspace_id, module_key);
