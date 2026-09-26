-- Migration 058: durable evidence for explicit USER-mode OAuth authorization.
-- The event deliberately stores no code, token, PKCE material, state, raw
-- redirect URI, request body, email address, IP address, or user agent.

CREATE TABLE IF NOT EXISTS oauth_authorization_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,
  source VARCHAR(30) NOT NULL,
  authorization_code_id UUID NOT NULL,
  user_id UUID NOT NULL,
  client_id VARCHAR(64) NOT NULL,
  client_name_snapshot VARCHAR(255) NOT NULL,
  redirect_origin TEXT NOT NULL,
  authorization_mode VARCHAR(10) NOT NULL,
  agent_id UUID,
  scope VARCHAR(255) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_events_code
  ON oauth_authorization_events (authorization_code_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_events_user_created
  ON oauth_authorization_events (user_id, created_at);

CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_events_client_created
  ON oauth_authorization_events (client_id, created_at);
