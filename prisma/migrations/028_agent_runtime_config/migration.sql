-- Migration 028: Agent Runtime Config
-- Deployment-global singleton holding the current "golden" Vercel Sandbox
-- snapshot id for the in-app agent runtime (agent turns boot from it to skip
-- npm install). Exactly one row, enforced by a UNIQUE index on `scope`
-- (always 'global'). See docs/decisions/0001-in-app-agent-architecture.md §3.
--
-- DSQL rules:
--   No FK constraints. One DDL statement per transaction (apply each
--   separately). The UNIQUE index is created ASYNC.

CREATE TABLE agent_runtime_config (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scope              VARCHAR(20)  NOT NULL DEFAULT 'global',
  golden_snapshot_id VARCHAR(255),
  deps_fingerprint   VARCHAR(64),
  snapshot_built_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ASYNC agent_runtime_config_scope_key ON agent_runtime_config (scope);
