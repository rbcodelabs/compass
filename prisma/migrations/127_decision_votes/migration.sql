-- migration 127: advisory votes on tracked Decisions (ADR-0030).
-- Additive: one new table and one unique async index. No backfill and no existing table touched: a
-- Decision with no rows here simply has no votes, so the code can ship before this is applied (the
-- embed card then shows no tally).
--
-- decision_votes: one row per (request, revision, question, voter). A vote belongs to the revision it
-- was cast on, so a revised question starts a fresh tally. chosen_option is the option label, checked
-- against the options of that question in the frozen packet by the service. Votes are advisory: nothing
-- here reads or writes review_requests, decision_records or any approval state.
--
-- Aurora DSQL rules followed:
--   - No foreign keys: workspace_id / request_id / revision_id / voter_user_id are bare UUIDs
--     validated in application code (lib/decision-votes.ts).
--   - One DDL statement per statement, each idempotent (IF NOT EXISTS).
--   - The index is CREATE UNIQUE INDEX ASYNC, with no ASC/DESC and no partial index. Its leading
--     (request_id, revision_id) columns also serve the tally read, so there is no second index.
--   - No trigger and no @updatedAt: updated_at is set by the application on every write.

CREATE TABLE IF NOT EXISTS decision_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  request_id UUID NOT NULL,
  revision_id UUID NOT NULL,
  question_index INTEGER NOT NULL,
  chosen_option VARCHAR(120) NOT NULL,
  voter_user_id UUID NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_decision_votes_voter ON decision_votes(request_id, revision_id, question_index, voter_user_id);
