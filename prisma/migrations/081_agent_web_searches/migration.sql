-- Migration 081: audit + per-turn budget for the agent-only web_search tool.
-- Additive: one new table, no index, no backfill. The tool is off by default and
-- fails closed while this table is absent, so the code can ship before this is applied.
--
-- One row per search the agent attempted. The composite PRIMARY KEY
-- (credential_id, seq) is the budget: credential_id is the 5-minute AGENT_TURN
-- credential (one per turn), and a search claims the next seq by inserting it. Two
-- racing searches cannot both claim the same seq, so the per-turn cap holds without
-- a lock, and counting a turn's searches is a primary-key range scan.
--
-- The row stores the query and the result URLs (not page content or snippets) so an
-- operator can answer "what did the agent send to a third party, for whom".
--
-- Aurora DSQL rules followed:
--   - No foreign keys: every id column is a bare UUID.
--   - No secondary index, so no async build is involved.
--   - No trigger: finished_at is set by the application.

CREATE TABLE IF NOT EXISTS agent_web_searches (
  credential_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  user_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  conversation_id UUID,
  query VARCHAR(400) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'STARTED',
  result_count INTEGER NOT NULL DEFAULT 0,
  result_urls JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP(3),
  PRIMARY KEY (credential_id, seq)
);
