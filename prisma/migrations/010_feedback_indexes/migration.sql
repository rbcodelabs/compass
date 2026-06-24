CREATE INDEX ASYNC idx_feedback_workspace_id ON feedback (workspace_id);
CREATE INDEX ASYNC idx_feedback_status ON feedback (status);
CREATE INDEX ASYNC idx_feedback_votes_feedback_id ON feedback_votes (feedback_id);
CREATE INDEX ASYNC idx_roadmap_votes_roadmap_item_id ON roadmap_votes (roadmap_item_id)
