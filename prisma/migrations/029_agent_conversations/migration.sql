-- Migration 029: Agent Conversations
-- Chat history for the in-app agent: agent_conversations (one per chat, scoped
-- to a workspace + owning user) and agent_messages (turns, assistant rows carry
-- usage/cost). See docs/decisions/0001-in-app-agent-architecture.md Phase 3.
--
-- DSQL rules:
--   No FK constraints (workspace_id / user_id / conversation_id are plain UUID
--   columns; relations enforced by Prisma + app code). One DDL per statement.
--   Indexes created ASYNC.

CREATE TABLE agent_conversations (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID         NOT NULL,
  user_id      UUID         NOT NULL,
  title        VARCHAR(255),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE agent_messages (
  id              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID             NOT NULL,
  role            VARCHAR(20)      NOT NULL,
  content         TEXT             NOT NULL,
  model           VARCHAR(100),
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  num_turns       INTEGER,
  cost_usd        DOUBLE PRECISION,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX ASYNC agent_conversations_workspace_user_idx ON agent_conversations (workspace_id, user_id);

CREATE INDEX ASYNC agent_messages_conversation_created_idx ON agent_messages (conversation_id, created_at);
