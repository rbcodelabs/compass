-- Migration 030: Agent Audit Log
-- Append-only trail of agent-initiated mutation tool calls (ADR 0001, Phase 5).
-- DSQL rules: no FK constraints; one DDL per statement; indexes created ASYNC.

CREATE TABLE agent_audit_log (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL,
  workspace_id    UUID         NOT NULL,
  conversation_id UUID,
  tool_name       VARCHAR(100) NOT NULL,
  args_summary    TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ASYNC agent_audit_log_workspace_created_idx ON agent_audit_log (workspace_id, created_at);

CREATE INDEX ASYNC agent_audit_log_user_created_idx ON agent_audit_log (user_id, created_at);
