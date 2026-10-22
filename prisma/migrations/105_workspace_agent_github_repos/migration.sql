-- Migration 105: Workspace agent GitHub repo allowlist
--
-- Nullable TEXT column holding a JSON array of "owner/name" strings: the
-- repositories a workspace admin has approved for agent sandboxes. NULL or
-- empty means agents get no GitHub token. Plain ADD COLUMN, no default, no
-- constraint, IF NOT EXISTS for idempotent reruns (DSQL rules, see 055).

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_github_repos TEXT;
