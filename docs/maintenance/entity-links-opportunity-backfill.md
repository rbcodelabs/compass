# entity_links phase 5: Opportunity <-> Objective and the Opportunity -> Key Result pointer

Runbook for migration `095_entity_links_backfill_opportunity` (ADR "One generic entity_links table", phase 5). Nothing here applies
anything by itself.

## What ships

- Two registry types: `OPPORTUNITY_TARGETS_OBJECTIVE` (origin `DIRECT` or `LEGACY` preserved from `opportunity_objective_links`) and
  `OPPORTUNITY_TARGETS_KEY_RESULT` (the granularity `opportunities.linked_key_result_id` carries; origin `LEGACY`, at most one per opportunity).
- A dual-write mirror in `lib/typed-links.ts` / `lib/links/legacy-mirror.ts`, in the same transaction as the legacy write, behind
  `COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR` (off in production unless `1`). The legacy table and column remain the source of truth; reads,
  summaries and the generic link tools ignore both types. Removal never depends on the flag.
- The explicit-only data migration `095` (no DDL). An untargeted POST never runs it.

## Order of operations (each production step needs the owner's explicit yes)

1. Run `entity-links-opportunity-preflight.psql` (read-only) and read the counts and expected orphans. After the code is deployed the same numbers are
   in `GET /api/admin/migrate` under `entityLinksOpportunityBackfill` (counts and capped ids only).
2. Decide who resolves quarantined rows (see below). 095 never links, changes or deletes them.
3. Confirm migration 091 (entity_links) is applied (GET `appliedMigrations`; 095 refuses without 091, 071 and 068). Deploy the code, set `COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR=1`, redeploy so every instance mirrors.
4. Pick a quiet window for the POST (fewer concurrent link writes; a live write racing a batch is handled by retry, but quiet is cheaper). Note the GET status runs a dozen aggregate queries over the link tables, so poll it sparingly on large datasets. `GET /api/admin/migrate`, then `POST /api/admin/migrate` with `{"script":"095_entity_links_backfill_opportunity"}`, then the status GET again and an
   application-level readback (the response log lists the quarantined ids).
5. Rollback is the flag: set it off and nothing new is written or read. The mirror rows are inert without readers.

## Quarantine

Legacy rows that are not mirrored, by class: `dangling` (an endpoint is gone), `crossWorkspace` (Opportunity and Objective in different workspaces,
or an Objective with no workspace_id), `linkWorkspaceDrift` (the link row's workspace differs from its endpoints'), `invalidOrigin`. They are
left untouched and reported on every run; the postconditions allow them only because they are reported. A mirror row whose legacy row is quarantined (for example an endpoint deleted after the mirror row was written) is KEPT, never deleted, and reported separately as `mirrorRowsKeptForQuarantine` (count plus capped entity_links ids) in the POST log and GET status.

## Residual pass

095 re-selects from the legacy tables on every run, so it is its own residual pass: it prunes mirror rows with no legacy counterpart, repairs
origin/workspace drift and inserts what is missing, then proves the postconditions. If the read flip needs a re-run after the mirror has been live, register a
DDL-free `096_..._residual` that calls `backfillEntityLinksOpportunity` and `assertEntityLinksOpportunityBackfill` (the 072/094 pattern). It is not built
here because nothing yet calls for it.

## Known mirror gaps the backfill covers

- A Key Result delete clears pointers in its own transaction; the pointer mirror rows are removed by the best-effort drain after it (logged and
  swallowed on failure), like phase 4's solution links. A failed drain leaves a row 095 prunes.
- Origin changes made while the flag is off are not mirrored; 095 repairs them. With the flag off, removals of stale pointer and LEGACY objective rows still happen on the next legacy write (only creation is gated).
- A live writer inserting a pair between 095's select and insert makes the unique index refuse that batch; the hook re-selects (bounded), and a re-POST resumes anyway.

## Read flag and read parity (entity_links read flip)

`COMPASS_ENTITY_LINKS_OPPORTUNITY_READ` = `off | shadow | on` decides how readers treat `OPPORTUNITY_TARGETS_OBJECTIVE` (origin compared) and `OPPORTUNITY_TARGETS_KEY_RESULT` (the `linked_key_result_id` pointer). Fail-closed: only the exact strings `shadow` and `on` count (in production
exactly; elsewhere trimmed and case-insensitive), anything else, including unset, is `off`, and unlike the `*_MIRROR` flag there is no
default-on outside production. Semantics: `off` reads the legacy table only; `shadow` serves the legacy result and compares it with
`entity_links` (counts and ids only, never content), `on` serves `entity_links`. Rollback is always the flag set to `off`. The flag moves
`LegacyAdapter.mode` from `mirror` to `shadow` / `read` (`effectiveLegacyMode` in `lib/links/registry.ts`).

This change ships the flag, the comparator (`lib/links/read-compare.ts`) and the status below, and routes NO reader through them yet, so setting
the flag changes nothing until the reader PR for this family lands.

`GET /api/admin/migrate` reports `entityLinksReadParity` (read-only, counts and ids capped at 20): the read modes, `totalMismatches`, and per
type `legacyLive`, `mirrorLive`, `onlyLegacy` (a flipped reader would hide the link), `onlyEntityLinks` (it would show an extra link) and
`originDrift`. "Live" means both endpoints exist in the link's workspace, i.e. what the workspace-filtered readers show, so quarantined
rows (dangling, cross-workspace) are absent on both sides. Cost: one scan of the legacy table plus the mirror rows of the family's types
(`entity_links` has no index that leads with `link_type`); poll sparingly. Require zero mismatches (or an explained, repaired cause) before
setting the flag to `on`. Types in this family: `opportunityObjective`, `opportunityKeyResultPointer`.

The fourth family, `COMPASS_ENTITY_LINKS_SOLUTION_KR_READ` (`SOLUTION_TARGETS_KEY_RESULT`, status entry `solutionKeyResult`), has the same semantics but is new-only:
no backfill has run, so its parity will show `onlyLegacy` for every pre-mirror link and it must stay `off` or `shadow` until a backfill exists.
