-- Migration 068: proposed new entries for a card sort round
--
-- Lets a participant in an OPPORTUNITY round propose that a NEW opportunity be
-- added to the set being sorted. A row here is a pending request held on the
-- round; it is not an Opportunity and nothing in the OST changes until the
-- round's facilitator accepts it (which creates the real Opportunity and records
-- its id in accepted_object_id) or rejects it. Visibility follows the same
-- blind-vote rule as card_sort_proposals and is enforced in
-- lib/card-sort-new-entries.ts, not in the schema.
--
-- suggested_value is the bucket the proposer would put it in. It is optional and
-- is never applied as an official field value: on accept it becomes the
-- proposer's ordinary card_sort_proposals row on the new opportunity.
--
-- DSQL rules followed (same as migration 067):
--   - UUID PK via gen_random_uuid(), no SERIAL.
--   - No FK constraints. relationMode="prisma" is set on the datasource, so
--     round_id / user_id / resolved_by_id / accepted_object_id are validated in
--     app code.
--   - No @updatedAt. updated_at defaults to CURRENT_TIMESTAMP on insert and is
--     bumped on update by the injectUpdatedAt client extension.
--   - The index is ASYNC, the only form DSQL supports. The runner rewrites ASYNC
--     away when DATABASE_URL signals local PostgreSQL.
--   - Each statement runs in its own transaction per the runner.
--
-- Purely additive: one new table, no ALTER of an existing one, no backfill.
-- Nothing reads it until someone proposes an entry, so applying this migration is
-- a no-op for every existing surface.
--
-- Index rationale: (round_id, status) backs the round page, which loads every
-- entry for one round and separates pending from resolved.

CREATE TABLE IF NOT EXISTS card_sort_new_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL,
  user_id UUID NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  suggested_value VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  accepted_object_id UUID,
  resolved_by_id UUID,
  resolved_at TIMESTAMP,
  resolution_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_card_sort_new_entries_round_status ON card_sort_new_entries (round_id, status);
