-- Migration 126: external links from Solutions and Tasks to GitHub PRs, Jira issues, Figma, Google files, Slack threads and
-- plain URLs (ADR-0028). Additive: one new table and two async indexes. Nothing existing changes, so the code can ship before
-- this is applied (a missing table only makes the Links section report an error).
--
-- external_links: one row per link from a subject (SOLUTION or TASK) to an external resource. url and external_key are rebuilt
-- by lib/external-links.ts, never the raw paste. status_snapshot is reserved for phase 2 and nothing writes it yet.
--
-- Aurora DSQL rules followed: no foreign keys (subject_id is validated against the workspace in code), idempotent statements,
-- CREATE INDEX ASYNC with no ASC/DESC.

CREATE TABLE IF NOT EXISTS external_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  subject_type VARCHAR(40) NOT NULL,
  subject_id UUID NOT NULL,
  provider VARCHAR(30) NOT NULL,
  url VARCHAR(1000) NOT NULL,
  external_key VARCHAR(1000) NOT NULL,
  title VARCHAR(255) NOT NULL,
  relation VARCHAR(20) NOT NULL,
  status_snapshot TEXT,
  source VARCHAR(20) NOT NULL DEFAULT 'UI',
  created_by_id UUID,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_external_links_subject_key ON external_links(subject_type, subject_id, provider, external_key);

CREATE INDEX ASYNC IF NOT EXISTS idx_external_links_workspace_key ON external_links(workspace_id, provider, external_key);
