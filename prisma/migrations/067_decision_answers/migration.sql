-- Migration 067: Decision answers
-- Adds a nullable answers_json to decision_records so a decision on a
-- multi-question request (packet `questions`) can record the reviewer's
-- per-question answers durably: a JSON array of
-- { questionIndex, question, chosenOption }. Additive only: existing rows and
-- every decision on an option-less or single-options request keep NULL, which
-- the application reads as "no per-question answers".
--
-- DSQL rules followed (matching 065_review_option_description):
--   - Plain ALTER TABLE ADD COLUMN: no FK, no index, no CREATE TYPE.
--   - IF NOT EXISTS for idempotent reruns.
--   - No DEFAULT / NOT NULL on ADD COLUMN: DSQL rejects any constraint on it.
--   - TEXT rather than a bounded VARCHAR; the shape and bounds are enforced in
--     application code (lib/decision-service.ts) against the immutable packet.

ALTER TABLE "decision_records" ADD COLUMN IF NOT EXISTS "answers_json" TEXT;
