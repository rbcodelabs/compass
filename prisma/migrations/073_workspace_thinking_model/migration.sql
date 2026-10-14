-- Migration 073: workspace thinking model (ADR "Thinking-model presets and typed
-- links", Phase 3A, migration only).
--
-- Adds two nullable columns to workspaces:
--   thinking_model         VARCHAR(40)  which preset the workspace uses
--   thinking_model_labels  TEXT         JSON-encoded label overrides for that preset
--
-- NULL in either column means "today's behavior". Nothing reads these columns
-- yet and schema.prisma deliberately does not declare them: this migration ships
-- on its own so it can be applied BEFORE the code that selects them. The shared
-- workspace select feeds every page, so selecting a missing column would 500 the
-- whole app. Deploy order is: apply this migration, then deploy the code PR.
--
-- DSQL rules followed (matching 067_decision_answers):
--   - Plain ALTER TABLE ADD COLUMN, one DDL per statement. No index, no foreign
--     key, no CHECK, no backfill.
--   - No DEFAULT and no NOT NULL on ADD COLUMN: DSQL rejects any constraint on it.
--     Allowed values and the labels shape are enforced in application code.
--   - IF NOT EXISTS so a resumed or repeated run is a no-op.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS thinking_model VARCHAR(40);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS thinking_model_labels TEXT;
