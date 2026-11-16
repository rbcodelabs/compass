-- Migration 124: audit + per-turn budget for the agent-only web_fetch tool.
-- Additive: one new table, no secondary index, no backfill. The tool fails closed while
-- this table is absent, so the code can ship before this is applied.
--
-- One row per fetch the agent attempted. The composite PRIMARY KEY (credential_id, seq)
-- is the attempt ceiling: credential_id is the 5-minute AGENT_TURN credential (one per
-- turn), and an attempt claims the next seq by inserting it. Two racing attempts cannot
-- both claim the same seq, so the per-turn ceiling holds without a lock, and counting a
-- turn's attempts is a primary-key range scan.
--
-- `status` is what the budget reads: only STARTED (in flight) and SUCCEEDED rows spend
-- the per-turn fetch budget. BLOCKED (refused by URL policy) and FAILED (transfer error,
-- non-2xx, unreadable content type) rows are kept for the audit but do not spend it.
--
-- The row stores the URL (credentials stripped), the final URL after redirects, the HTTP
-- status, the decompressed byte count and a short outcome code. It never stores page
-- content or response headers.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: every id column is a bare UUID.
--   - No secondary index, so no async build is involved.
--   - No trigger: finished_at is set by the application.
--   - Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS agent_web_fetches (
  credential_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  user_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  conversation_id UUID,
  url VARCHAR(2048) NOT NULL,
  final_url VARCHAR(2048),
  status VARCHAR(20) NOT NULL DEFAULT 'STARTED',
  outcome VARCHAR(40),
  http_status INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP(3),
  PRIMARY KEY (credential_id, seq)
);
