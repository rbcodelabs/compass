-- Migration 051: Decision -> task bridge
--
-- Supports the decision->task bridge (Compass solution 51a047e2):
--   1. requested_by_agent_id on review_requests -- fixes the item-5 blocker.
--      request_decision previously persisted only requestedById (always the
--      API key's owning user, even when the caller is an agent), so every
--      decision raised by an agent was indistinguishable from one raised by
--      the human who eventually answers it. This column carries the actual
--      Agent id, resolved from the McpActor at request time
--      (actor.purpose === "AGENT" -> actor.agentId), so a suggested assignee
--      can point at the agent that was blocked waiting on the decision
--      instead of the person who just answered it. Tracked as feedback
--      f546cf13-e6a0-4213-8be9-0cfdebbf4ff7.
--   2. no_action_at / no_action_by_id / no_action_reason on review_requests --
--      the explicit "no action needed, here's why" close-out for a DECIDED
--      decision that genuinely doesn't warrant follow-up work. Together with
--      the new DECISION task_links.linked_type value (added in application
--      code below -- see note), this makes "decided with nothing linked and
--      not explicitly closed" a computable, honest "awaiting follow-through"
--      state instead of a silent gap.
--
-- No change needed for task_links.linked_type: it is a free VARCHAR with no
-- DB-level enum or CHECK constraint (see prisma/schema.prisma comment on
-- TaskLink.linkedType) -- the vocabulary lives entirely in application code
-- (lib/types.ts TaskLinkedType). Adding "DECISION" as a valid value is a
-- code-only change; this migration only needs to add columns.
--
-- DSQL rules followed (per CLAUDE.md / .claude/pr-guidelines.md):
--   - ALTER TABLE ADD COLUMN must NOT include NOT NULL or DEFAULT -- all four
--     columns are nullable, no backfill: every pre-existing review_requests
--     row (all 14 in the dogfood workspace as of 2026-09-12) gets NULL for
--     all four, which is the correct "unknown / not agent-raised / not yet
--     closed" value.
--   - No FK constraints -- plain UUID columns, same as requested_by_id and
--     assigned_to_id already on this table.
--   - No index -- none of these four columns are filtered/joined on in any
--     query added by this feature. requested_by_agent_id is read per-row
--     (get_decision/list_decisions), and the "awaiting follow-through" query
--     filters on existing (workspaceId, state) which idx_review_requests_workspace_state
--     already covers, then cross-references task_links in application code
--     via its existing (linked_type, linked_id) index -- no new index needed
--     on either table.

ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS requested_by_agent_id UUID;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS no_action_at TIMESTAMP;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS no_action_by_id UUID;
ALTER TABLE review_requests ADD COLUMN IF NOT EXISTS no_action_reason TEXT;
