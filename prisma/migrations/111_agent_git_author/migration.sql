-- Migration 111: per-agent git author for cloud agent commits.
-- Additive: two nullable columns, no backfill, no index. NULL (either column) reads as the built-in
-- "Compass Agent" bot identity, so the code can ship before this is applied.
--
-- agents.git_author_name / agents.git_author_email: the identity commits made by this agent's runs are
-- authored as. Vercel (and GitHub) attribute a commit by author email, so for deployments to build on a
-- private repo the email must belong to a GitHub account that is a member of the Vercel team.
--
-- Aurora DSQL rules followed: one idempotent DDL statement per statement, no foreign keys.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_author_name VARCHAR(100);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS git_author_email VARCHAR(254);
