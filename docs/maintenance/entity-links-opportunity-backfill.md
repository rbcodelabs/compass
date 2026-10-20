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
3. Deploy the code, set `COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR=1`, redeploy so every instance mirrors.
4. `GET /api/admin/migrate`, then `POST /api/admin/migrate` with `{"script":"095_entity_links_backfill_opportunity"}`, then the status GET again and an
   application-level readback (the response log lists the quarantined ids).
5. Rollback is the flag: set it off and nothing new is written or read. The mirror rows are inert without readers.

## Quarantine

Legacy rows that are not mirrored, by class: `dangling` (an endpoint is gone), `crossWorkspace` (Opportunity and Objective in different workspaces,
or an Objective with no workspace_id), `linkWorkspaceDrift` (the link row's workspace differs from its endpoints'), `invalidOrigin`. They are
left untouched and reported on every run; the postconditions allow them only because they are reported.

## Residual pass

095 re-selects from the legacy tables on every run, so it is its own residual pass: it prunes mirror rows with no legacy counterpart, repairs
origin/workspace drift and inserts what is missing, then proves the postconditions. If the read flip needs a re-run after the mirror has been live, register a
DDL-free `096_..._residual` that calls `backfillEntityLinksOpportunity` and `assertEntityLinksOpportunityBackfill` (the 072/094 pattern). It is not built
here because nothing yet calls for it.

## Known mirror gaps the backfill covers

- A Key Result delete clears pointers in its own transaction; the pointer mirror rows are removed by the best-effort drain after it (logged and
  swallowed on failure), like phase 4's solution links. A failed drain leaves a row 095 prunes.
- Origin changes made while the flag is off are not mirrored; 095 repairs them.
