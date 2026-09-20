-- Migration 056: Agent binding for OAuth tokens (ADR 0015)
--
-- Phase 1 OAuth (055) issues tokens that resolve to purpose "USER", which
-- bypasses the entire agent authorization model: AgentWorkspaceGrant narrowing,
-- the three "Human administrator required." assertions, and the 17 DENY entries
-- in AGENT_TOOL_POLICY. Measured on production for the same account, an OAuth
-- token saw 7 workspaces where the equivalent agent key saw 6.
--
-- This migration adds the columns that let a token name an agent instead of a
-- user. See docs/design/agent-scoped-oauth.md ("Data model") and
-- docs/decisions/0015-agent-scoped-oauth-tokens.md.
--
--   oauth_authorization_codes  + authorization_mode, agent_id
--   oauth_tokens               + authorization_mode, agent_id, agent index
--   oauth_consents             + authorization_mode, agent_id
--   agent_tool_calls           + credential_type
--
-- WHY authorization_mode IS A SEPARATE COLUMN FROM agent_id. A null agent_id
-- must not be ambiguous between "the user elected the admin override" and "this
-- row predates agent binding". Inferring the mode from `agent_id IS NULL` would
-- collapse those two into one value and turn a security column into a footgun,
-- so the mode is stored explicitly and read as a closed two-way switch: only
-- exact "AGENT" and "USER" values are accepted; null or unknown values fail
-- closed.
--
-- WHY agent_tool_calls.credential_type. An agent-bound OAuth token must supply
-- a credentialId to withAgentActivity (lib/agent-activity.ts:7) or every
-- mutation throws "Incomplete agent identity." while every read succeeds. The
-- value supplied is OAuthToken.id, which makes agent_tool_calls.credential_id
-- polymorphic across api_keys.id and oauth_tokens.id in a bare UUID column with
-- no discriminator. credential_type is that discriminator. Without it, a future
-- join from credential_id to api_keys silently drops every OAuth-issued call
-- rather than failing loudly.
--
-- NOT IN THIS MIGRATION, deliberately. The design also calls for revoking every
-- live oauth_token and deleting every oauth_consent row (forced re-consent), so
-- that the over-privileged Phase 1 tokens stop working. That is a later stage:
-- it must land together with the consent screen that can actually mint a
-- replacement agent-bound token, otherwise it breaks every live connection with
-- no way to restore it. Until then, legacy rows keep resolving to purpose
-- "USER" — today's shipped behavior, unchanged.
--
-- DSQL rules followed:
--   - No FK constraints (relationMode = "prisma"); agent_id is validated in app
--     code on every use, not by the database.
--   - No DEFAULT clause on ALTER TABLE ADD COLUMN: DSQL rejects any constraint
--     there ("ALTER TABLE ADD COLUMN with constraint not supported"), confirmed
--     live against preview during 055_workspace_launch_workflow_flag. So each
--     column is added nullable and backfilled with a separate UPDATE. Prisma's
--     `@default("USER")` in schema.prisma applies at the ORM layer for new
--     create() calls only; it is not DDL.
--   - One DDL statement per transaction: no explicit BEGIN/COMMIT, each
--     statement is its own implicit transaction, matching 052 through 055.
--   - CREATE INDEX ASYNC, the only form DSQL supports. The runner rewrites
--     ASYNC away when DATABASE_URL signals local PostgreSQL.
--   - Every statement is IF NOT EXISTS or an idempotent conditional UPDATE, so a
--     rerun after a timed-out async index wait resumes instead of failing. The
--     backfills are `WHERE ... IS NULL`, so they never overwrite a real value on
--     a second pass.
--
-- Sizing: 055 needed roughly three POSTs to apply because 4 DDL plus 9 ASYNC
-- index submissions exceeded the route's maxDuration = 60. This is 7 nullable
-- ADD COLUMNs (which do not rewrite the table on DSQL), 4 small backfills, and
-- a single ASYNC index — the index is the only slow submission. Budget 1-2
-- POSTs and expect the same resume behavior.
--
-- Index rationale: idx_oauth_tokens_agent backs "which live tokens are bound to
-- this agent?", which is what agent suspension and the Connected apps panel
-- need. Not on the hot path — token validation still resolves through
-- idx_oauth_tokens_hash and reads agent_id off the row it already found.

ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS authorization_mode VARCHAR(10);
ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS agent_id UUID;

ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS authorization_mode VARCHAR(10);
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS agent_id UUID;

ALTER TABLE oauth_consents ADD COLUMN IF NOT EXISTS authorization_mode VARCHAR(10);
ALTER TABLE oauth_consents ADD COLUMN IF NOT EXISTS agent_id UUID;

ALTER TABLE agent_tool_calls ADD COLUMN IF NOT EXISTS credential_type VARCHAR(10);

UPDATE oauth_authorization_codes SET authorization_mode = 'USER' WHERE authorization_mode IS NULL;
UPDATE oauth_tokens SET authorization_mode = 'USER' WHERE authorization_mode IS NULL;
UPDATE oauth_consents SET authorization_mode = 'USER' WHERE authorization_mode IS NULL;

-- Every existing row was written by withAgentActivity from an ApiKey-derived
-- actor, because the OAuth path could not produce an AGENT actor before this
-- change. So "API_KEY" is a statement of fact, not an assumption.
UPDATE agent_tool_calls SET credential_type = 'API_KEY' WHERE credential_type IS NULL;

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_tokens_agent ON oauth_tokens (agent_id);
