-- Migration 125: bind portal sessions to the workspace that issued them (GHSA-8734-6xx5-cwf6, finding 8).
-- Additive: one nullable column on each of two tables, no default, no backfill, no index, no FK (DSQL rules, see 114/117).
--   portal_sessions.workspace_id            UUID  the workspace whose portal issued the session; honored only there.
--   portal_verification_tokens.workspace_id UUID  the workspace the magic link was requested from; carried into the session on verify.
-- NULL is never honored: a session row that predates this column has no issuing workspace and cannot be trusted
-- (accounts are global by email, so guessing one would reproduce the bug), so those sessions simply stop working and
-- the visitor signs in again. Nothing is rewritten or deleted here. DSQL rejects DEFAULT on ADD COLUMN, and no index is
-- needed because sessions are looked up by the unique token_hash, then compared to the workspace in application code.

ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS workspace_id UUID;
ALTER TABLE portal_verification_tokens ADD COLUMN IF NOT EXISTS workspace_id UUID;
