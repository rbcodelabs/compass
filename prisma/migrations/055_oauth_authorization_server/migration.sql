-- Migration 055: OAuth authorization server for the MCP endpoint
--
-- Creates the four tables Compass needs to be its own OAuth 2.1 authorization
-- server on the same origin as its MCP resource server:
--   oauth_clients              — RFC 7591 dynamically registered clients
--   oauth_authorization_codes  — single-use codes, 60 s TTL, PKCE challenge
--   oauth_tokens               — opaque access/refresh tokens, SHA-256 at rest
--   oauth_consents             — prior grants, so repeat authorizations skip
--                                the consent screen
--
-- See docs/design/mcp-oauth-discovery.md ("Data model"). Nothing here touches
-- an existing table, so this migration cannot affect any current behavior.
--
-- Numbered 055, not 054: two independent 054s already landed on main
-- (054_research_study_artifact, 054_workspace_wip_limits). The runner keys on
-- the exact name so a third would be tolerated, but the convention recorded on
-- 052/053 is not to add further duplicates.
--
-- DSQL rules followed:
--   - UUID PKs via gen_random_uuid(), no SERIAL.
--   - No FK constraints anywhere (relationMode = "prisma"); user_id,
--     client_id, scope_workspace_id and parent_token_id are validated in app
--     code like every other cross-table reference in this schema.
--   - No triggers, so no @updatedAt: these rows are either immutable or have
--     an explicit lifecycle column (consumed_at, revoked_at, last_used_at).
--   - redirect_uris / grant_types are JSONB, not Postgres arrays.
--   - Every index is CREATE INDEX ASYNC, the only form DSQL supports. The
--     runner rewrites ASYNC away when DATABASE_URL signals local PostgreSQL.
--   - One DDL statement per transaction: no explicit BEGIN/COMMIT, each
--     statement is its own implicit transaction, matching 052 and 053.
--   - Every statement is IF NOT EXISTS, so a re-run after a timed-out async
--     index wait resumes instead of failing.
--
-- Index rationale:
--   - idx_oauth_clients_client_id, idx_oauth_authorization_codes_hash and
--     idx_oauth_tokens_hash are uniqueness constraints the Prisma models
--     declare, not optimizations — they have to exist regardless of table size.
--     The two hash indexes are also the single lookup on the hot path: every
--     MCP request with a cmp_oat_ bearer resolves through idx_oauth_tokens_hash.
--   - idx_oauth_tokens_family backs refresh-rotation reuse detection, which
--     revokes an entire family in one statement.
--   - idx_oauth_tokens_user_client backs the "Connected apps" settings panel.
--   - the two *_expires indexes back TTL pruning of dead codes and tokens.
--   - idx_oauth_clients_last_used backs TTL pruning of clients that registered
--     but never completed an authorization — load-bearing because DCR is open
--     and unauthenticated by design.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id VARCHAR(64) NOT NULL,
  client_secret_hash VARCHAR(64),
  client_name VARCHAR(255) NOT NULL,
  redirect_uris JSONB NOT NULL,
  grant_types JSONB NOT NULL,
  scope VARCHAR(255) NOT NULL,
  token_endpoint_auth_method VARCHAR(30) NOT NULL,
  logo_uri TEXT,
  client_uri TEXT,
  software_id VARCHAR(255),
  registration_access_token_hash VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash VARCHAR(64) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  user_id UUID NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge VARCHAR(128) NOT NULL,
  code_challenge_method VARCHAR(10) NOT NULL,
  scope VARCHAR(255) NOT NULL,
  resource TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(64) NOT NULL,
  type VARCHAR(10) NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  user_id UUID NOT NULL,
  scope VARCHAR(255) NOT NULL,
  resource TEXT NOT NULL,
  scope_workspace_id UUID,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  family_id UUID NOT NULL,
  parent_token_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS oauth_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  scope VARCHAR(255) NOT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_oauth_clients_client_id ON oauth_clients (client_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_clients_last_used ON oauth_clients (last_used_at);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_codes_hash ON oauth_authorization_codes (code_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_codes_expires ON oauth_authorization_codes (expires_at);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_oauth_tokens_hash ON oauth_tokens (token_hash);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_tokens_family ON oauth_tokens (family_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_tokens_user_client ON oauth_tokens (user_id, client_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens (expires_at);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_oauth_consents_user_client ON oauth_consents (user_id, client_id);
