-- Migration 032: Doc Inline Anchored Comments
-- Adds a DocComment table: Google-Docs-style inline comments on a Doc. Threads
-- are exactly one level deep -- a root comment (parent_id NULL) optionally
-- carries an anchor into the doc's plain-text projection; replies (parent_id
-- set) never carry an anchor. Anchors are NEVER embedded in the doc's markdown
-- content -- the highlight is resolved at render time from the anchor fields
-- (see lib/comment-anchor.ts). Comments are resolvable (status OPEN | RESOLVED).
--
-- DSQL rules:
--   No FK constraints in DDL -- doc_id and parent_id are plain UUID columns;
--   the relations are enforced by Prisma (relationMode = "prisma") and
--   application code only. Deleting a root comment deletes its replies first,
--   and deleteDoc bulk-deletes a doc's comments before deleting the Doc row.
--   No CREATE TYPE, no @default(autoincrement()).
--   Indexes are created ASYNC.

CREATE TABLE doc_comments (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID          NOT NULL,
  parent_id     UUID,
  body          TEXT          NOT NULL,
  status        VARCHAR(20)   NOT NULL DEFAULT 'OPEN',
  anchor_text   TEXT,
  anchor_prefix VARCHAR(100),
  anchor_suffix VARCHAR(100),
  anchor_start  INTEGER,
  anchor_end    INTEGER,
  author_name   VARCHAR(255)  NOT NULL,
  author_id     UUID,
  author_type   VARCHAR(20)   NOT NULL DEFAULT 'HUMAN',
  source        VARCHAR(20)   NOT NULL DEFAULT 'UI',
  created_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC doc_comments_doc_id_status_idx ON doc_comments (doc_id, status);
