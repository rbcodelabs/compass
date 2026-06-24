ALTER TABLE "roadmap_items"
  ADD COLUMN IF NOT EXISTS "opportunity_id" UUID;

ALTER TABLE "objectives"
  ADD COLUMN IF NOT EXISTS "parent_key_result_id" UUID;

CREATE INDEX ASYNC IF NOT EXISTS "idx_roadmap_items_opportunity_id"
  ON "roadmap_items" ("opportunity_id");

CREATE INDEX ASYNC IF NOT EXISTS "idx_objectives_parent_key_result_id"
  ON "objectives" ("parent_key_result_id");
