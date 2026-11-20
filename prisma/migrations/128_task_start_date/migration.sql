-- Migration 128: tasks.start_date, the optional start of a Task.
-- Additive: one nullable column, no default, no backfill, no index (DSQL rules, see 075/112/114).
-- NULL means the task has only a due date (a milestone at due_date). startDate <= dueDate is
-- enforced in application code (validateTaskDates), not in the database. Existing rows and old code are unaffected,
-- so apply this before the code that selects start_date ships.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
