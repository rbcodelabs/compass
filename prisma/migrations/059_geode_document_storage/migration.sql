ALTER TABLE docs ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(20);
ALTER TABLE docs ADD COLUMN IF NOT EXISTS content_ref TEXT;
ALTER TABLE docs ADD COLUMN IF NOT EXISTS revision UUID;
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(20);
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS content_ref TEXT;
CREATE TABLE IF NOT EXISTS doc_operations (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, operation_id UUID NOT NULL,
  doc_id UUID NOT NULL, payload_digest VARCHAR(64) NOT NULL, result TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS doc_operations_workspace_id_operation_id_key ON doc_operations(workspace_id, operation_id);
CREATE TABLE IF NOT EXISTS doc_storage_objects (
  id UUID PRIMARY KEY, workspace_id UUID NOT NULL, pathname TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
