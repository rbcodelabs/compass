-- Participant-submitted browser evidence, separate from authoritative voice records.
CREATE TABLE research_participant_voice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  session_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  client_event_id VARCHAR(255) NOT NULL,
  reported_ordinal INTEGER NOT NULL,
  claimed_speaker VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  turn_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ASYNC idx_participant_voice_client_event ON research_participant_voice_events (session_id, client_event_id);
CREATE UNIQUE INDEX ASYNC idx_participant_voice_ordinal ON research_participant_voice_events (session_id, lease_id, reported_ordinal);
CREATE UNIQUE INDEX ASYNC idx_participant_voice_turn ON research_participant_voice_events (turn_id);
CREATE INDEX ASYNC idx_participant_voice_workspace_session ON research_participant_voice_events (workspace_id, session_id);
