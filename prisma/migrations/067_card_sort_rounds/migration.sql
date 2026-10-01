-- Migration 067: card sort rounds and proposals
--
-- Adds the generic "propose moves on a factor" primitive: a CardSortRound names
-- a SELECT CustomFieldDefinition as the factor being judged, and each
-- CardSortProposal is one person's proposed move for one object in that round.
-- First consumer is the MoSCoW Priority exercise on Strategic Initiatives, but
-- nothing here is specific to it — the factor is whatever field the round points
-- at, and the buckets are that field's effective options (which may be inherited
-- from a SharedFieldOptionSet, migration 053).
--
-- Proposals are SPARSE DELTAS. A row exists only where someone actively
-- disagreed with the official value; absence means "no opinion recorded", never
-- implicit agreement. That semantic lives in lib/card-sort-tally.ts and is
-- asserted by __tests__/card-sort-tally.test.ts — the schema only has to avoid
-- contradicting it, which is why there is no per-object "agreed" row or count
-- column anywhere below.
--
-- DSQL rules followed:
--   - UUID PKs via gen_random_uuid(), no SERIAL.
--   - No FK constraints. relationMode="prisma" is already set on the datasource,
--     so round_id / workspace_id / field_definition_id / user_id / object_id are
--     validated in app code, consistent with every other reference in this
--     schema.
--   - No @updatedAt. updated_at defaults to CURRENT_TIMESTAMP on insert and is
--     bumped on update by the injectUpdatedAt client extension
--     (lib/prisma-updated-at.ts), because DSQL has no ON UPDATE triggers.
--   - Indexes are ASYNC, the only form DSQL supports. The runner rewrites ASYNC
--     away when DATABASE_URL signals local PostgreSQL.
--   - Each statement below runs in its own transaction per the runner.
--
-- Purely additive: two new tables, no ALTER of an existing one, no backfill.
-- Nothing reads these tables until a round is created, so applying this
-- migration is a no-op for every existing surface.
--
-- Numbered 067 because 066 is the highest number taken on main. Duplicate prefixes
-- already exist (064 and 065 are each used twice); the registry in
-- lib/migrations/runner.ts is an ordered array, so a duplicate would make "which
-- one runs when" a question about array position rather than about the name.
--
-- Index rationale:
--   - The unique index on (round_id, user_id, object_id) is not an optimization,
--     it is the latest-wins constraint the Prisma model declares: one live
--     proposal per person per object per round, so changing your mind updates
--     rather than appends. The upsert path depends on it as a conflict target.
--   - (round_id, object_id) backs the tally, which groups every proposal in a
--     round by object. Without it the tally is a full scan of the round.
--   - (workspace_id, state) backs the round list screen, which always filters by
--     workspace and usually by state ("show me the OPEN round").

CREATE TABLE IF NOT EXISTS card_sort_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  object_type VARCHAR(50) NOT NULL,
  field_definition_id UUID NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_by_id UUID NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revealed_at TIMESTAMP,
  closed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS card_sort_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL,
  user_id UUID NOT NULL,
  object_id UUID NOT NULL,
  proposed_value VARCHAR(255) NOT NULL,
  from_value VARCHAR(255),
  rationale TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ASYNC IF NOT EXISTS idx_card_sort_rounds_workspace_state ON card_sort_rounds (workspace_id, state);

CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_card_sort_proposals_round_user_object ON card_sort_proposals (round_id, user_id, object_id);

CREATE INDEX ASYNC IF NOT EXISTS idx_card_sort_proposals_round_object ON card_sort_proposals (round_id, object_id);
