-- Migration 111: record which model credential an agent run used (TASK-89 follow-up)
--
-- One nullable VARCHAR(30) on agent_runs holding a closed, non-secret label (platform-api-key | workspace-api-key | claude-subscription |
-- bedrock | gateway; lib/agent-credential-source.ts). NULL means unknown: every run that predates this migration, and runs written while it
-- is unapplied. The code ships before this is applied (reads and writes are gated on a column probe). Never holds a key or token.
-- Plain ADD COLUMN, no default, no constraint, no index, no foreign key, IF NOT EXISTS for idempotent reruns (DSQL rules, see 055).

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS credential_source VARCHAR(30);
