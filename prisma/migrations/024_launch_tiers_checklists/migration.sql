-- Migration 024: Launch Tiers + Checklist Templates
-- Adds workspace-scoped checklist templates and per-launch checklist
-- instances so moving a RoadmapItem to the LAUNCHING horizon can require
-- picking a launch tier (TIER_1/2/3), which auto-attaches a checklist
-- cloned from the workspace's active template for that tier.
--
-- Four tables, mirroring the ScoringModel/ScoringModelMetric →
-- OpportunityScore template-vs-instance pattern in 019_scoring_models:
--   checklist_templates       — workspace-owned named presets, archive-only.
--   checklist_template_items  — the items that make up a template.
--   launch_checklists         — one per roadmap item launch, with a frozen
--                                snapshot of the template + items so history
--                                survives later template edits.
--   launch_checklist_items    — tri-state (PENDING/DONE/SKIPPED) items.
--
-- DSQL rules:
--   No FK constraints in DDL — workspace_id/roadmap_item_id/etc. are plain
--   UUID columns; relations are enforced by Prisma (relationMode = "prisma")
--   and application code only.
--   No JSON/JSONB columns — template_snapshot is stored as TEXT (JSON-encoded)
--   and parsed in application code.
--   No CREATE TYPE, no @default(autoincrement()).
--   New tables can carry NOT NULL DEFAULT (this restriction only applies to
--   ALTER TABLE ADD COLUMN on existing tables, per 014_feedback_type).
--   "order" is a reserved word — double-quoted, per 019_scoring_models.
--   Indexes are created ASYNC, including the unique one.

CREATE TABLE checklist_templates (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID          NOT NULL,
  tier           VARCHAR(20)   NOT NULL,
  name           VARCHAR(255)  NOT NULL,
  description    TEXT,
  status         VARCHAR(50)   NOT NULL DEFAULT 'ACTIVE',
  created_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE checklist_template_items (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_template_id  UUID          NOT NULL,
  label                  VARCHAR(255)  NOT NULL,
  description            TEXT,
  "order"                INTEGER       NOT NULL DEFAULT 0
);

CREATE TABLE launch_checklists (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_item_id        UUID          NOT NULL,
  checklist_template_id  UUID          NOT NULL,
  tier                   VARCHAR(20)   NOT NULL,
  template_snapshot      TEXT          NOT NULL,
  created_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE launch_checklist_items (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_checklist_id  UUID          NOT NULL,
  label                VARCHAR(255)  NOT NULL,
  description          TEXT,
  status               VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  "order"              INTEGER       NOT NULL DEFAULT 0,
  completed_at         TIMESTAMP(3),
  created_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC checklist_templates_workspace_id_idx ON checklist_templates (workspace_id);
CREATE INDEX ASYNC checklist_template_items_checklist_template_id_idx ON checklist_template_items (checklist_template_id);
CREATE UNIQUE INDEX ASYNC launch_checklists_roadmap_item_id_key ON launch_checklists (roadmap_item_id);
CREATE INDEX ASYNC launch_checklists_checklist_template_id_idx ON launch_checklists (checklist_template_id);
CREATE INDEX ASYNC launch_checklist_items_launch_checklist_id_idx ON launch_checklist_items (launch_checklist_id);
