-- Backing indexes for the server-side Feedback grid (sorting, filtering,
-- pagination and counting all happen in the database now).
--
-- Names match Prisma's default convention exactly, so `prisma migrate diff`
-- against schema.prisma reports no drift after this runs.
--
-- ASYNC is mandatory: Aurora DSQL does not support synchronous CREATE INDEX.
-- Each statement returns a job_id immediately and the index stays INVALID
-- until the background build finishes -- queries stay correct throughout,
-- they are simply not accelerated yet.
--
-- No ASC/DESC anywhere: DSQL's CREATE INDEX grammar allows only
-- `NULLS FIRST|LAST` per column, not a sort direction. `workspace_id` is
-- always pinned by equality, so a reverse index scan covers the
-- `ORDER BY vote_count DESC, created_at DESC` access path.

CREATE INDEX ASYNC feedback_workspace_id_vote_count_created_at_idx ON feedback (workspace_id, vote_count, created_at);

CREATE INDEX ASYNC feedback_workspace_id_status_idx ON feedback (workspace_id, status);

CREATE INDEX ASYNC feedback_workspace_id_type_idx ON feedback (workspace_id, type);

CREATE INDEX ASYNC feedback_workspace_id_created_at_idx ON feedback (workspace_id, created_at);

CREATE INDEX ASYNC feedback_opportunity_id_idx ON feedback (opportunity_id);
