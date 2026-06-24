-- Migration 009: feedback portal + roadmap voting
-- DSQL rules:
--   ALTER TABLE ADD COLUMN must NOT include NOT NULL or DEFAULT constraints
--   New CREATE TABLE statements can have defaults fine
--   No FK constraints in DDL

-- ── Workspace portal flags ─────────────────────────────────────────────────────
ALTER TABLE workspaces ADD COLUMN feedback_enabled BOOLEAN;
UPDATE workspaces SET feedback_enabled = false WHERE feedback_enabled IS NULL;

ALTER TABLE workspaces ADD COLUMN roadmap_public BOOLEAN;
UPDATE workspaces SET roadmap_public = false WHERE roadmap_public IS NULL;

-- ── feedback ──────────────────────────────────────────────────────────────────
CREATE TABLE feedback (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL,
  opportunity_id   UUID,
  title            VARCHAR(255) NOT NULL,
  description      TEXT,
  submitter_name   VARCHAR(255),
  submitter_email  VARCHAR(255),
  status           VARCHAR(50)  NOT NULL DEFAULT 'OPEN',
  vote_count       INTEGER      NOT NULL DEFAULT 0,
  tags             JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_feedback_workspace_id ON feedback (workspace_id);
CREATE INDEX idx_feedback_status       ON feedback (status);

-- ── feedback_votes ────────────────────────────────────────────────────────────
CREATE TABLE feedback_votes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id  UUID        NOT NULL,
  voter_email  VARCHAR(255) NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (feedback_id, voter_email)
);

CREATE INDEX idx_feedback_votes_feedback_id ON feedback_votes (feedback_id);

-- ── roadmap_votes ─────────────────────────────────────────────────────────────
CREATE TABLE roadmap_votes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  roadmap_item_id UUID        NOT NULL,
  voter_email     VARCHAR(255) NOT NULL,
  voter_name      VARCHAR(255),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (roadmap_item_id, voter_email)
);

CREATE INDEX idx_roadmap_votes_roadmap_item_id ON roadmap_votes (roadmap_item_id);
