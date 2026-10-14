-- Migration 068: Following and in-app notifications (slice 1, data model).
-- ADR "Following and in-app notifications" (Compass Docs, Architecture
-- Decisions). Two additive tables and five async indexes; no existing table
-- changes, and there is no data backfill (both tables start empty).
--
-- Aurora DSQL rules followed:
--   - No foreign keys: subjects are polymorphic (subject_type + subject_id) and
--     users/workspaces are referenced by bare UUID columns.
--   - One DDL statement per statement, every one idempotent (IF NOT EXISTS).
--   - Every index is CREATE INDEX ASYNC, with no ASC/DESC and no partial index.
--   - kind/state/source/actor_type are VARCHAR validated in application code,
--     not database enums (no CREATE TYPE).
--   - No trigger: updated_at is set by the application on every write.
--
-- follows.state is FOLLOWING or MUTED. MUTED is a tombstone: an unfollow keeps
-- the row so that auto-follow (create / comment / assign) never silently
-- re-follows a user who opted out.

CREATE TABLE IF NOT EXISTS follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL,
  subject_type VARCHAR(40) NOT NULL,
  subject_id UUID NOT NULL,
  state VARCHAR(20) NOT NULL,
  source VARCHAR(20) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Payload holds only minimal machine facts (from/to, commentId/parentCommentId);
-- never titles or excerpts, so a stale row exposes nothing. actor_id is null for
-- EXTERNAL and SYSTEM actors and is never an email address.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  recipient_user_id UUID NOT NULL,
  subject_type VARCHAR(40) NOT NULL,
  subject_id UUID NOT NULL,
  kind VARCHAR(40) NOT NULL,
  actor_type VARCHAR(20) NOT NULL,
  actor_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key VARCHAR(200) NOT NULL,
  read_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_follows_user_subject ON follows(user_id, subject_type, subject_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_follows_subject ON follows(subject_type, subject_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_follows_workspace_user ON follows(workspace_id, user_id);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_notifications_recipient_dedupe ON notifications(recipient_user_id, dedupe_key);

CREATE INDEX ASYNC IF NOT EXISTS idx_notifications_inbox ON notifications(workspace_id, recipient_user_id, created_at);
