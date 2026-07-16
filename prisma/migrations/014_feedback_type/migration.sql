-- Migration 014: separate bugs/problems from ideas/features on the Feedback board
-- See PR #39 (feat/feedback-bug-workflow).
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL constraints
--   New CREATE TABLE statements can have defaults fine
--   No FK constraints in DDL (relationMode = "prisma" enforces at app layer)

-- ── FeedbackItem.type — distinguishes BUG vs IDEA ────────────────────────────
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS type VARCHAR(50);
UPDATE feedback SET type = 'IDEA' WHERE type IS NULL;

-- ── RoadmapItem.feedbackId — links a roadmap item back to its source feedback ─
ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS feedback_id UUID;
