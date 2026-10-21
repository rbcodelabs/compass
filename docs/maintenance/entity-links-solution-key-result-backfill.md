# entity_links phase 4 (data half): Solution <-> Key Result

Runbook for migration `098_entity_links_backfill_solution_key_result` (ADR "One generic entity_links table", phase 4). Nothing here applies
anything by itself. (The numeric prefix 098 is shared with `098_agent_kind_and_workspace_owner`; duplicate prefixes are accepted, ADR-0012,
and the migration is always POSTed by its full name.)

## Why it exists

Phase 4 shipped the `SOLUTION_TARGETS_KEY_RESULT` mirror as new-only: only links written while `COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR` was on
reached `entity_links`. The read flip (`COMPASS_ENTITY_LINKS_SOLUTION_KR_READ`) cannot leave `off` while pre-mirror links are missing there, so
098 backfills them.

Production state when this was written: 9 legacy links in `solution_key_result_links`, 0 mirrored. Its `solutionKeyResult` entry in
`entityLinksReadParity` therefore shows `onlyLegacy` for every live link until 098 is applied; re-read that entry (and
`entityLinksSolutionKeyResultBackfill`) from `GET /api/admin/migrate` before and after the POST rather than trusting these numbers.

## What ships

- The explicit-only data migration `098_entity_links_backfill_solution_key_result` (no DDL). An untargeted POST never runs it; the registry
  adapter of `SOLUTION_TARGETS_KEY_RESULT` now names it as its `backfillMigration`.
- `GET /api/admin/migrate` reports `entityLinksSolutionKeyResultBackfill`: `legacyLinks`, `mirroredLinks`, `unmatched` (consistent legacy rows
  the POST would still insert or repair), `staleMirrorRows`, `quarantined` by class (counts plus capped ids) and `mirrorRowsKeptForQuarantine`.
- Mirror semantics are the live writer's (`mirrorSolutionTargetsKeyResult`): `workspace_id` from the verified Solution row, `origin` `DIRECT`
  (the legacy table has no origin). `source`, `created_by_id` and `created_at` are copied from the legacy row, so the mirror shows who
  made the link and when, as 095/097 do.

## Order of operations (each production step needs the owner's explicit yes)

1. Run `entity-links-solution-key-result-preflight.psql` (read-only) and read the counts and expected orphans. After the code is deployed
   the same numbers are in `GET /api/admin/migrate` under `entityLinksSolutionKeyResultBackfill`.
2. Decide who resolves quarantined rows (see below). 098 never links, changes or deletes them.
3. Confirm migrations 068, 071 and 091 are applied (GET `appliedMigrations`; 098 refuses without them and changes nothing). Deploy the code, set
   `COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR=1`, redeploy so every instance mirrors.
4. `GET /api/admin/migrate`, then `POST /api/admin/migrate` with `{"script":"098_entity_links_backfill_solution_key_result"}`, then the status
   GET again and an application-level readback (the response log lists inserted/repaired/pruned counts and the quarantined ids).
   `entityLinksReadParity.solutionKeyResult` should show zero `onlyLegacy`, `onlyEntityLinks` and `originDrift` afterwards.
5. Rollback is the flag: set it off and nothing new is written or read. The mirror rows are inert without readers.

## What a run does

In committed batches of 500, in order: prune mirror rows with no legacy counterpart (re-checked inside the DELETE), repair mirror rows whose
`workspace_id` differs from the verified Solution's, insert the consistent legacy rows that have no mirror row (anti-join on the unique pair;
no `ON CONFLICT`). Idempotent and resumable: a finished table selects nothing in any step, and a second run reports `inserted 0, repaired 0,
pruned 0`.

## Quarantine

Legacy rows that are not mirrored, by class: `dangling` (the Solution, the Key Result or the Key Result's Objective is gone), `crossWorkspace`
(Solution and Objective in different workspaces, or either has no `workspace_id`), `linkWorkspaceDrift` (the link row's `workspace_id` differs
from its endpoints'). They are left untouched and reported on every run (`solution_key_result_links` ids); the postconditions allow them only
because they are reported. A mirror row whose legacy row is quarantined (an endpoint deleted after the mirror row was written) is KEPT, never
deleted, and reported separately as `mirrorRowsKeptForQuarantine` (count plus capped `entity_links` ids) in the POST log and the GET status.

## Postconditions (before the receipt)

Zero consistent legacy rows without a matching mirror row (workspace included); zero duplicate `(from, type, to)` pairs; every mirror row's
`workspace_id` equals its Solution's and its Key Result's Objective's; no mirror row has a missing endpoint unless its legacy row is one of the
reported quarantined rows. Any failure throws before the receipt, so the attempt stays unfinished and a re-POST resumes.

## Residual pass

098 re-selects from the legacy table on every run, so a re-POST is its own residual pass. If the read flip needs a separately numbered re-run
(for example the best-effort drains left drift), register a DDL-free residual that calls `backfillEntityLinksSolutionKeyResult` and
`assertEntityLinksSolutionKeyResultBackfill` (the 072/094 pattern). It is not built here because nothing yet calls for it.

## Known mirror gaps the backfill covers

- A Key Result or Solution delete removes the legacy links in its own transaction; mirror rows go in a best-effort drain afterwards (logged and
  swallowed on failure). A failed drain leaves a row 098 prunes.
- Links written while the flag is off are not mirrored; 098 inserts them.
- A live writer inserting a pair between 098's select and insert makes the unique index refuse that batch; the hook re-selects (bounded), and a
  re-POST resumes anyway.
