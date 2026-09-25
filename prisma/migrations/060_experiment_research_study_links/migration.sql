-- Organizational links only: no changes to study protocols or experiment outcomes.
CREATE TABLE IF NOT EXISTS experiment_research_study_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  experiment_id UUID NOT NULL,
  study_id UUID NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id UUID,
  source VARCHAR(20) NOT NULL DEFAULT 'UI'
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_experiment_study_links_pair
  ON experiment_research_study_links (experiment_id, study_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_experiment_study_links_workspace
  ON experiment_research_study_links (workspace_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_experiment_study_links_study
  ON experiment_research_study_links (study_id);
