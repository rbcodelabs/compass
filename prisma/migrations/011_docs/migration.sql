CREATE TABLE docs (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID         NOT NULL,
  parent_id    UUID,
  title        VARCHAR(255) NOT NULL DEFAULT 'Untitled',
  content      TEXT,
  icon         VARCHAR(50),
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ASYNC idx_docs_workspace_id ON docs (workspace_id);
CREATE INDEX ASYNC idx_docs_parent_id    ON docs (parent_id);
