CREATE TABLE IF NOT EXISTS workspace_update_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL,
 revision INTEGER NOT NULL, entity_type VARCHAR(40) NOT NULL, entity_id UUID NOT NULL,
 group_type VARCHAR(40) NOT NULL, group_id UUID NOT NULL, kind VARCHAR(40) NOT NULL,
 actor_type VARCHAR(20) NOT NULL, actor_id UUID, before VARCHAR(80), after VARCHAR(80),
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS workspace_update_events_revision_key ON workspace_update_events(workspace_id, revision);
CREATE TABLE IF NOT EXISTS workspace_updates_state (workspace_id UUID PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS workspace_updates_read_state (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, user_id UUID NOT NULL,
 caught_up_revision INTEGER NOT NULL DEFAULT 0, previous_revision INTEGER, version UUID NOT NULL, baseline_at TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS workspace_updates_read_state_user_key ON workspace_updates_read_state(workspace_id, user_id);
