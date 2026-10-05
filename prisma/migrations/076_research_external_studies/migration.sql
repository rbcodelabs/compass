-- Migration 075: external / manual research studies.
--
-- Lets a ResearchStudy (study_type = 'EXTERNAL') be a home for research that was
-- run OUTSIDE Compass's AI interviewer (UserTesting, Maze, a call the team ran
-- themselves). Sessions are pasted in by a workspace member and stored as ordinary
-- research_sessions/research_turns rows so the existing analysis, synthesis and
-- evidence-promotion paths work on them unchanged.
--
-- Adds nullable columns only:
--   research_studies.external_provider  VARCHAR(30)  USERTESTING | MAZE | OTHER (app-validated)
--   research_studies.external_url       TEXT         optional link to the study at the provider
--   research_sessions.provenance        VARCHAR(30)  NULL = native Compass session;
--                                                    'EXTERNAL_IMPORT' = pasted by a member
--   research_sessions.external_url      TEXT         optional link to the session at the provider
--   research_sessions.session_notes     TEXT         the researcher's own notes / summary
--
-- NULL means "today's behavior" for every existing row, so there is no backfill.
-- Provenance is member-reported, NOT provider-authenticated: nothing here verifies
-- that the provider produced the transcript.
--
-- DSQL rules followed (matching 073_workspace_thinking_model):
--   - Plain ALTER TABLE ADD COLUMN, one DDL statement each. No index, no foreign
--     key, no CHECK, no DEFAULT and no NOT NULL (DSQL rejects constraints on
--     ADD COLUMN). Allowed values are enforced in application code.
--   - IF NOT EXISTS so a resumed or repeated run is a no-op.

ALTER TABLE research_studies ADD COLUMN IF NOT EXISTS external_provider VARCHAR(30);
ALTER TABLE research_studies ADD COLUMN IF NOT EXISTS external_url TEXT;
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS provenance VARCHAR(30);
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS external_url TEXT;
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS session_notes TEXT;
