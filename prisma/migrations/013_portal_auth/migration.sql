-- Migration 013: portal account authentication
-- See ADR: Claude/compass-portal-auth-adr-2026-07-03.md
-- Portal accounts/sessions are intentionally non-interoperable with Auth.js —
-- no FK to users/sessions/verification_tokens, ever.
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL constraints
--   New CREATE TABLE statements can have defaults fine
--   No FK constraints in DDL (relationMode = "prisma" enforces at app layer)

-- ── Workspace opt-in toggle ─────────────────────────────────────────────────
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS portal_auth_required BOOLEAN;
UPDATE workspaces SET portal_auth_required = false WHERE portal_auth_required IS NULL;

-- ── portal_accounts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL,
  name           VARCHAR(255),
  email_verified TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email)
);

-- ── portal_sessions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  portal_account_id UUID        NOT NULL,
  token_hash        VARCHAR(64) NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);

CREATE INDEX ASYNC IF NOT EXISTS idx_portal_sessions_portal_account_id ON portal_sessions (portal_account_id);

-- ── portal_verification_tokens ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_verification_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email      VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);

CREATE INDEX ASYNC IF NOT EXISTS idx_portal_verification_tokens_email ON portal_verification_tokens (email);

-- ── Nullable portal_account_id links on existing feedback/vote tables ────────
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS portal_account_id UUID;
ALTER TABLE feedback_votes ADD COLUMN IF NOT EXISTS portal_account_id UUID;
ALTER TABLE roadmap_votes ADD COLUMN IF NOT EXISTS portal_account_id UUID;
