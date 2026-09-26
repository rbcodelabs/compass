-- ADR-0018: OAuth-authenticated third-party MCP connectors. Compass as an OAuth
-- *client* of somebody else's MCP server, so the cloud agent can call out to it.
--
-- Purely additive — no existing table is altered. A deployment that has not yet
-- applied this migration keeps working with the single hardcoded Compass MCP
-- server, because lib/mcp-connectors/store.ts treats a missing table (P2021) as
-- "no connectors configured" rather than an error, following the ADR-0016
-- precedent for code that ships ahead of its migration.
--
-- DSQL: no foreign keys (application-scoped integrity), no JSON columns, no
-- DEFAULT on ALTER TABLE ADD COLUMN, indexes created ASYNC.
CREATE TABLE IF NOT EXISTS "mcp_connectors" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "slug" VARCHAR(40) NOT NULL,
  "origin" VARCHAR(255) NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "server_url" TEXT NOT NULL,
  "resource" TEXT NOT NULL,
  "authorization_endpoint" TEXT NOT NULL,
  "token_endpoint" TEXT NOT NULL,
  "revocation_endpoint" TEXT,
  "scope" VARCHAR(255) NOT NULL,
  "client_id" VARCHAR(255) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "mcp_connector_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "connector_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "access_token_encrypted" TEXT NOT NULL,
  "refresh_token_encrypted" TEXT,
  "access_token_expires_at" TIMESTAMP(3),
  "scope" VARCHAR(255) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "mcp_connector_auth_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "state" VARCHAR(64) NOT NULL,
  "connector_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "code_verifier" VARCHAR(128) NOT NULL,
  "redirect_uri" TEXT NOT NULL,
  "return_to" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique indexes first; correctness depends on all three.
--
-- (slug, origin) is what makes lazy per-origin DCR safe: two concurrent first
-- connects from the same preview URL race to register, and the loser's insert
-- must collide rather than create a second registration.
--
-- `state` unique is what makes the callback's conditional updateMany a genuine
-- single-use consume — without it, two rows could share a state and each be
-- consumed once.
--
-- (connector_id, user_id) enforces one grant per user per connector, so a second
-- authorization upserts rather than accumulating shadow grants whose refresh
-- races each other.
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_mcp_connectors_slug_origin" ON "mcp_connectors" ("slug", "origin");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_mcp_connector_auth_requests_state" ON "mcp_connector_auth_requests" ("state");
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS "idx_mcp_connector_grants_connector_user" ON "mcp_connector_grants" ("connector_id", "user_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_mcp_connector_grants_user" ON "mcp_connector_grants" ("user_id");
CREATE INDEX ASYNC IF NOT EXISTS "idx_mcp_connector_auth_requests_expires" ON "mcp_connector_auth_requests" ("expires_at");
