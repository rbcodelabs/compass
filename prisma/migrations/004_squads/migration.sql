CREATE TABLE "squads" (
    "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID          NOT NULL,
    "name"         VARCHAR(255)  NOT NULL,
    "color"        VARCHAR(50)   NOT NULL DEFAULT '#6366f1',
    "created_at"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "squads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX ASYNC "squads_workspace_id_idx" ON "squads" ("workspace_id");

ALTER TABLE "objectives"    ADD COLUMN IF NOT EXISTS "squad_id" UUID;
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "squad_id" UUID;
ALTER TABLE "experiments"   ADD COLUMN IF NOT EXISTS "squad_id" UUID;
ALTER TABLE "roadmap_items" ADD COLUMN IF NOT EXISTS "squad_id" UUID;

CREATE INDEX ASYNC "objectives_squad_id_idx"    ON "objectives"    ("squad_id");
CREATE INDEX ASYNC "opportunities_squad_id_idx" ON "opportunities" ("squad_id");
CREATE INDEX ASYNC "experiments_squad_id_idx"   ON "experiments"   ("squad_id");
CREATE INDEX ASYNC "roadmap_items_squad_id_idx" ON "roadmap_items" ("squad_id");
