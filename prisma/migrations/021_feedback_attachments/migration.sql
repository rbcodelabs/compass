-- Migration 021: Feedback Attachments
-- Adds a FeedbackAttachment table so customer feedback items (public portal
-- submissions and internally-created items alike) can carry uploaded files
-- (screenshots, PDFs, plain text/CSV) stored in Vercel Blob. One row per
-- attached file, referencing the parent feedback item.
--
-- DSQL rules:
--   No FK constraints in DDL — feedback_item_id is a plain UUID column;
--   the relation is enforced by Prisma (relationMode = "prisma") and
--   application code only.
--   No CREATE TYPE, no @default(autoincrement()).
--   Indexes are created ASYNC.

CREATE TABLE feedback_attachment (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_item_id UUID          NOT NULL,
  url              TEXT          NOT NULL,
  filename         VARCHAR(255)  NOT NULL,
  file_type        VARCHAR(100)  NOT NULL,
  file_size        INTEGER       NOT NULL,
  created_at       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC feedback_attachment_feedback_item_id_idx ON feedback_attachment (feedback_item_id);
