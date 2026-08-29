BEGIN;
CREATE TABLE IF NOT EXISTS "artifacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "source_type" VARCHAR(30) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "current_revision_id" UUID,
  "created_by_id" UUID,
  "updated_by_id" UUID,
  "source" VARCHAR(20) NOT NULL DEFAULT 'UI',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "artifact_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "artifact_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "blob_pathname" TEXT,
  "filename" VARCHAR(255),
  "mime_type" VARCHAR(100),
  "byte_size" INTEGER,
  "sha256" VARCHAR(64),
  "external_url" TEXT,
  "created_by_id" UUID,
  "source" VARCHAR(20) NOT NULL DEFAULT 'UI',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_revisions_artifact_id_revision_number_key" UNIQUE ("artifact_id", "revision_number")
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS "artifact_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "linked_type" VARCHAR(30) NOT NULL,
  "linked_id" UUID NOT NULL,
  "created_by_id" UUID,
  "source" VARCHAR(20) NOT NULL DEFAULT 'UI',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifact_links_artifact_id_linked_type_linked_id_key" UNIQUE ("artifact_id", "linked_type", "linked_id")
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "artifacts_workspace_id_status_updated_at_idx" ON "artifacts"("workspace_id", "status", "updated_at");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "artifact_revisions_artifact_id_created_at_idx" ON "artifact_revisions"("artifact_id", "created_at");
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS "artifact_links_workspace_id_linked_type_linked_id_idx" ON "artifact_links"("workspace_id", "linked_type", "linked_id");
COMMIT;
