-- Immutable declarative capability packs for the in-app agent.
-- DSQL: JSON is encoded as TEXT; application code owns referential integrity;
-- every DDL statement has its own transaction and indexes are asynchronous.

BEGIN;
CREATE TABLE IF NOT EXISTS capability_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id VARCHAR(120) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idx_capability_packs_pack_id UNIQUE (pack_id)
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS capability_pack_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_pack_id UUID NOT NULL,
  semantic_version VARCHAR(80) NOT NULL,
  source_repository TEXT NOT NULL,
  source_commit VARCHAR(40) NOT NULL,
  source_path TEXT NOT NULL,
  artifact_sha256 VARCHAR(64) NOT NULL,
  artifact_pathname TEXT NOT NULL,
  sdk_compatibility VARCHAR(120) NOT NULL,
  manifest_json TEXT NOT NULL,
  validation_status VARCHAR(20) NOT NULL DEFAULT 'VALID',
  validation_message TEXT,
  created_by_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idx_capability_pack_versions_identity UNIQUE (capability_pack_id, semantic_version, source_commit)
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS workspace_capability_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  capability_pack_id UUID NOT NULL,
  capability_pack_version_id UUID NOT NULL,
  enabled_skill_ids TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idx_workspace_capability_packs_workspace_pack UNIQUE (workspace_id, capability_pack_id)
);
COMMIT;

BEGIN;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS pack_provenance TEXT;
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS idx_capability_pack_versions_digest ON capability_pack_versions (artifact_sha256);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS idx_workspace_capability_packs_enabled ON workspace_capability_packs (workspace_id, enabled);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS idx_workspace_capability_packs_version ON workspace_capability_packs (capability_pack_version_id);
COMMIT;
