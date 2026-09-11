BEGIN;
CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id UUID NOT NULL,
  parent_id UUID,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  author_id UUID,
  author_name VARCHAR(255) NOT NULL,
  author_type VARCHAR(20) NOT NULL DEFAULT 'HUMAN',
  source VARCHAR(20) NOT NULL DEFAULT 'UI',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS doc_comment_anchors (
  comment_id UUID PRIMARY KEY,
  anchor_text TEXT NOT NULL,
  anchor_prefix VARCHAR(100),
  anchor_suffix VARCHAR(100),
  anchor_start INTEGER,
  anchor_end INTEGER
);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS solution_plan_proposals (
  comment_id UUID PRIMARY KEY,
  tracked_decision_request_id UUID,
  legacy_plan_status VARCHAR(20)
);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS idx_comments_target_status ON comments (workspace_id, target_type, target_id, status);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS idx_comments_parent ON comments (parent_id);
COMMIT;

BEGIN;
CREATE INDEX ASYNC IF NOT EXISTS idx_solution_plan_proposals_decision ON solution_plan_proposals (tracked_decision_request_id);
COMMIT;
