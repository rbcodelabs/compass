ALTER TABLE pm_interviews ADD COLUMN IF NOT EXISTS agent_conversation_id UUID;
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_pm_interviews_agent_conversation ON pm_interviews(agent_conversation_id);
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS interview_processing_json TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope_conversation_id UUID;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope_claim_id UUID;
