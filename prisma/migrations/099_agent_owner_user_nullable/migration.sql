-- Migration 099: agents.owner_user_id becomes nullable
-- (ADR "Cloud agents as first-class identities", PR1 of 4; follows 098's additive columns).
--
-- A WORKSPACE-owned agent has no owner user, so the column must accept NULL. Kept in its own
-- migration because ALTER COLUMN ... DROP NOT NULL is in DSQL's documented ALTER TABLE syntax
-- (migration 070 relies on the same statement) but has not been exercised on a live DSQL cluster
-- from this repo. If DSQL refuses it, only this migration's receipt is blocked; 098 stays recorded.
-- The postcondition in lib/migrations/agent-kind-and-workspace-owner.ts proves the catalog really
-- changed before the receipt is written.
--
-- WORKSPACE-owned agent creation must not ship until 098 and 099 are both confirmed applied.
-- Nothing in this release creates one, and rows that exist keep a non-null owner, so the code is
-- safe to deploy first.

ALTER TABLE agents ALTER COLUMN owner_user_id DROP NOT NULL;
