# entity_links phase 7: task links

Runbook for migration `097_entity_links_backfill_task` (ADR "One generic entity_links table", phase 7). Nothing here applies anything by itself.
(096 belongs to the artifact-link phase; the gap is intentional.)

## What ships

- One registry type, `TASK_REFERENCES`: a Task (`from`) to any of the nine task-link targets (`to`): OPPORTUNITY, SOLUTION, ROADMAP_ITEM,
  OBJECTIVE, KEY_RESULT, DOC, EXPERIMENT, FEEDBACK_ITEM and DECISION. A task link calls a review request `DECISION`; the alias
  (`lib/entity-types.ts`) is normalised, so only `REVIEW_REQUEST` is ever stored in `entity_links.to_type`. Origin is always `DIRECT`;
  `source`, `created_by_id` and `created_at` are copied from `task_links`. One type, not nine, because every target shares the rules; the
  target type is the `toType`.
- A dual-write mirror (`lib/task-link-writes.ts`, `lib/links/legacy-mirror.ts`), in the same transaction as the legacy write, behind
  `COMPASS_ENTITY_LINKS_TASK_MIRROR` (off in production unless exactly `1`). `task_links` remains the source of truth; reads, summaries and the
  generic link tools ignore the type (`link_entities` names `link_task` when asked to write it). Removal never depends on the flag.
- The explicit-only data migration `097` (no DDL). An untargeted POST never runs it.
- `linked_type = 'COMMENT'` (the Doc comment a task was made from) is NOT mirrored by design. It is counted in the status
  (`commentLinksExcluded`), never quarantined, never touched.

Writers wired: UI link/unlink, add/link a task from an entity panel, `createWorkspaceTask` (nested links), MCP `link_task`/`unlink_task`,
the decision follow-through task. Cleanup wired (whatever the flag says): `deleteObjective` / `deleteKeyResult` (after commit, best effort),
`deleteDocument`, the feedback purge route, and the workspace cascade (endpoint sweeps for TASK, ROADMAP_ITEM, FEEDBACK_ITEM, DOC,
REVIEW_REQUEST plus the workspace-stamped sweep that already ran first). Opportunity, Solution, Objective and Key Result deletes are
already covered by the typed-link sweeps, which remove every `entity_links` row naming them.

## Order of operations (each production step needs the owner's explicit yes)

1. Run `entity-links-task-preflight.psql` (read-only) and read the counts and expected orphans. After the code is deployed the same numbers
   are in `GET /api/admin/migrate` under `entityLinksTaskBackfill` (counts and capped ids only).
2. Decide who resolves quarantined rows (see below). 097 never links, changes or deletes them.
3. Confirm migration 091 (entity_links) is applied (GET `appliedMigrations`; 097 refuses without 091 and 068). Deploy the code, set
   `COMPASS_ENTITY_LINKS_TASK_MIRROR=1`, redeploy so every instance mirrors.
4. Pick a quiet window for the POST. Cost: `task_links` is the largest link table. The backfill is keyset-paged in committed batches of 500,
   one target type at a time through the `(linked_type, linked_id)` index and the `entity_links` pair index; measured on a throwaway
   Postgres 16, 200,000 links took about 90 s and a no-op re-run about 6 s. `GET /api/admin/migrate` runs a pass over `task_links` per target
   type plus two passes over the mirror rows (`entity_links` has no index that leads with `link_type`); about 5 s at 200,000 mirrored rows,
   so poll it sparingly. `POST /api/admin/migrate` with `{"script":"097_entity_links_backfill_task"}`, then the status GET again and an
   application-level readback (the response log lists the quarantined ids).
5. Rollback is the flag: set it off and nothing new is written or read. The mirror rows are inert without readers.

## Quarantine

Legacy rows that are not mirrored, by class: `dangling` (the task or the target is gone), `crossWorkspace` (task and target in different
workspaces, or a target whose workspace is NULL: an unbackfilled Solution or Objective, or a Key Result under one), `unsupportedType` (a
`linked_type` that is neither one of the nine nor `COMMENT`, for example a stray `SQUAD`). They are left untouched and reported on every
run (task_links ids); the postconditions allow them only because they are reported. A mirror row whose legacy row is quarantined (a target
deleted after the mirror row was written) is KEPT, never deleted, and reported separately as `mirrorRowsKeptForQuarantine` (count plus capped
entity_links ids) in the POST log and the GET status.

Note: legacy deletes of an Opportunity, Solution, Doc, Roadmap item, Feedback item and similar targets have never removed their
`task_links`, so `dangling` rows are expected and are not a regression.

## Postconditions (before the receipt)

Zero consistent legacy rows without a matching mirror row (workspace, origin and stored type included); zero duplicate
`(from, type, to)` pairs; every mirror row's `workspace_id` equals its task's and its target's; no mirror row has a missing endpoint unless
its legacy row is one of the reported quarantined rows.

## Residual pass

097 re-selects from `task_links` on every run, so a re-POST is its own residual pass: it prunes mirror rows with no legacy counterpart,
repairs workspace/origin/type drift and inserts what is missing, then proves the postconditions. If the read flip needs a separately numbered
re-run, register a DDL-free `098_..._residual` that calls `backfillEntityLinksTask` and `assertEntityLinksTaskBackfill` (the 072/094
pattern). It is not built here because nothing yet calls for it.

## Known mirror gaps the backfill covers

- A Key Result / Objective delete removes the legacy links in its own transaction; the mirror rows go in a best-effort drain after it
  (logged and swallowed on failure). The typed-link drain that runs just before it (`drainLinksFor`) already removes every `entity_links` row
  naming that Objective or Key Result, so the task-reference drain is a second, narrower pass for the case where that one failed. A failed
  drain leaves rows 097 prunes or reports as kept.
- Links written while the flag is off are not mirrored; 097 inserts them.
- A live writer inserting a pair between 097's select and insert makes the unique index refuse that batch; the hook re-selects (bounded) and
  a re-POST resumes anyway. The insert itself re-checks the task and the target, so a row that went bad since the select is not linked.
- MCP `unlink_task` for a task row that has vanished deletes only the legacy link (the service verifies the task); 097 prunes that mirror row.

## Required before the read flip: legacy-dangling is absent

The UI Objective/Key Result delete (`okrs/actions.ts`), `deleteDocument` and the feedback purge route drop the mirror rows of the deleted
target but have never removed its legacy `task_links` (the legacy tables simply keep a dangling row). 097 therefore reports those legacy rows
as `dangling`, and they have no mirror row. A reader flipped to `entity_links` is consistent with that only if the legacy reader also treats a
link to a missing target as absent (the workspace-filtered endpoint reads already do). Verify this on the legacy read paths before flipping,
or clean the dangling `task_links` rows as a separate, owner-approved step. This PR does not change those delete paths.
