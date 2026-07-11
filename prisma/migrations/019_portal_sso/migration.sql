-- Migration 019: portal SSO Identify
-- Adds a per-workspace SSO toggle + encrypted shared secret so a customer's
-- own backend can mint a short-lived signed JWT asserting one of their
-- logged-in users' identity, exchange it at /api/portal/[org]/[ws]/sso, and
-- land on the SAME PortalAccount/PortalSession system that magic-link auth
-- already uses (see migration 013). Orthogonal to portal_auth_required —
-- this does not change whether voting requires sign-in, it only unlocks a
-- second, instant front door for establishing the same session.
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL constraints

-- ── Workspace SSO opt-in + encrypted secret ─────────────────────────────────
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sso_enabled BOOLEAN;
UPDATE workspaces SET sso_enabled = false WHERE sso_enabled IS NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sso_secret_encrypted TEXT;
