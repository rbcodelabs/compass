-- Migration 082: external (outsider) artifact share.
-- Additive: four new tables and their async indexes. NOTHING is added to `artifacts`,
-- so the code can ship before this is applied: until it is, no share row exists and
-- every artifact behaves exactly as before.
--
-- artifact_shares: at most one row per artifact (unique artifact_id).
--   token_hash         sha256 of the random link token. The raw token is shown to the
--                      owner once; rotating the link replaces the hash.
--   password_hash      scrypt hash of the single shared password. password_changed_at
--                      invalidates every unlock/commenter session created before it.
--   comments_enabled   external viewers may comment (email magic link). Application code
--                      additionally requires an email provider to be configured.
--   revoked_at         set = link is dead; clearing it is a fresh enable.
--   failed_attempts / failed_window_at   compare-and-set throttle on wrong passwords.
-- artifact_share_sessions: one row per successful password unlock (opaque token, hashed).
-- artifact_share_commenters: one row per verified email session scoped to one share.
-- artifact_share_events: append-only owner-action audit trail.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: every *_id column is a bare UUID validated in application code.
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - Indexes are CREATE [UNIQUE] INDEX ASYNC, with no ASC/DESC and no partial index.
--   - DEFAULTs only appear inside CREATE TABLE (never on ADD COLUMN).
--   - No trigger: updated_at is set by the application on every write.

CREATE TABLE IF NOT EXISTS artifact_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_changed_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  comments_enabled BOOLEAN NOT NULL DEFAULT false,
  enabled_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP(3),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  failed_window_at TIMESTAMP(3),
  created_by_id UUID NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_artifact_shares_artifact ON artifact_shares(artifact_id);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_artifact_shares_token_hash ON artifact_shares(token_hash);

CREATE TABLE IF NOT EXISTS artifact_share_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_artifact_share_sessions_token_hash ON artifact_share_sessions(token_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_artifact_share_sessions_share ON artifact_share_sessions(share_id);

CREATE TABLE IF NOT EXISTS artifact_share_commenters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  portal_account_id UUID NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_artifact_share_commenters_token_hash ON artifact_share_commenters(token_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_artifact_share_commenters_share ON artifact_share_commenters(share_id);

CREATE TABLE IF NOT EXISTS artifact_share_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_artifact_share_events_artifact_created ON artifact_share_events(artifact_id, created_at);
