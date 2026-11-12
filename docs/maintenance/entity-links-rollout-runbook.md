# entity_links rollout runbook

> **STATUS: rollout complete.** All four families read and write `entity_links` only; the mirror and read flags and the shadow comparator
> are gone from the code. The only remaining work is the irreversible drop of the legacy tables and the `opportunities.linked_key_result_id`
> column (migration `116_entity_links_drop_legacy_tables`), which has its own runbook: **`entity-links-legacy-drop.md`**. The steps below are
> kept as history and for a deployment that has not been through them yet.

Operator steps for moving each link family from the legacy tables to `entity_links` (ADR "One generic entity_links table"). It applies per
deployment: run the whole sequence on each database you operate. Every production change below needs an explicit go-ahead from the owner.
Authenticate with the `x-migration-secret` header; never print the secret or put it in a file.

Families and their flags (all four use the same two flags):

| Family | Backfill migration | Mirror flag | Read flag |
|---|---|---|---|
| `SOLUTION_KR` | `098_entity_links_backfill_solution_key_result` | `COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR` | `COMPASS_ENTITY_LINKS_SOLUTION_KR_READ` |
| `OPPORTUNITY` | `095_entity_links_backfill_opportunity` (+ `106_entity_links_residual_opportunity`) | `COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR` | `COMPASS_ENTITY_LINKS_OPPORTUNITY_READ` |
| `ARTIFACT` | `096_entity_links_backfill_artifact` | `COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR` | `COMPASS_ENTITY_LINKS_ARTIFACT_READ` |
| `TASK` | `097_entity_links_backfill_task` | `COMPASS_ENTITY_LINKS_TASK_MIRROR` | `COMPASS_ENTITY_LINKS_TASK_READ` |

Read modes are `off` (legacy only), `shadow` (legacy served, compared against `entity_links`, mismatches logged) and `on` (`entity_links`
served). Flags are plain env vars: a change needs a redeploy to take effect.

## Per-deployment sequence

1. **Deploy** the current `main`. The status GET must load `entityLinksReadParity`; on Aurora DSQL the parity query skips
   `SET LOCAL statement_timeout` (DSQL rejects it).
2. **Mirror on.** Set the family's `*_MIRROR=1` and redeploy, so new writes land in both tables before any backfill runs.
3. **Backfill, one family at a time.** `GET /api/admin/migrate` first and confirm the migration is listed under `explicitOnlyPending`,
   then `POST /api/admin/migrate` with `{"script":"<exact migration name>"}`. Never POST without `script`. These are explicit-only and
   are skipped by an untargeted POST. Re-run the GET after each POST.
4. **Parity gate.** After each POST, `entityLinksReadParity.totalMismatches` must be 0, and every family must show `onlyLegacy`,
   `onlyEntityLinks` and `originDrift` all 0. Stop on any DSQL or runner error and investigate; do not retry blindly.
5. **Shadow.** Set `*_READ=shadow`, redeploy, and let real traffic run for at least a day. Search runtime logs for
   `entity_links read failed` and `[entity-links read-compare] mismatch`. Both must be empty.
6. **On.** Flip one family at a time to `on`, redeploy, and repeat the parity GET and log search. Leave each family `on` through a soak
   before flipping the next.
7. **Cleanup.** The code half is DONE (this change): the legacy readers, the dual-write mirror, the read-flag switch and the shadow
   comparator are removed, so `entity_links` is the only code path. It must not deploy to a database until every family is `*_READ=on`
   there (a deployment still on `off` or `shadow` would show empty links after the deploy, because the cleanup code never reads the legacy
   tables again) and the parity GET was 0. The legacy tables, their Prisma models and the migrations stay in place. The
   `COMPASS_ENTITY_LINKS_*_MIRROR` and `*_READ` env vars are ignored and can be deleted from each environment after the deploy.
   The follow-up change drops the four legacy tables (`opportunity_objective_links`, `solution_key_result_links`, `artifact_links`,
   `task_links`) and the `opportunities.linked_key_result_id` column with the explicit-only migration `116_entity_links_drop_legacy_tables`
   (see `entity-links-legacy-drop.md`), removes their Prisma models, `lib/legacy-link-tables.ts` and the deploy-before-migration-115 read
   fallback. The COMMENT and AGENT_CONVERSATION task links were never mirrored; they moved into `entity_links` (`TASK_CREATED_FROM`) by
   migration `115_entity_links_task_link_move` (see `entity-links-task-link-move.md`), which must have run in a deployment before that
   follow-up code is deployed there.

## Residual drift

The runner never re-runs an applied migration, so re-POSTing an applied backfill does nothing. Rows written while a mirror flag was off
are picked up by a separately numbered, DDL-free, explicit-only residual that calls the same two exported functions. The existing one is
`106_entity_links_residual_opportunity`, which re-runs the 095 hook and postconditions under its own receipt. Add another residual (next
free number) rather than editing a shipped one.

## Rollback

Before the step 7 code is deployed: set the family's `*_READ` back to `shadow` (or `off`) and redeploy. Reads return to the legacy tables
immediately; the mirror keeps writing, so no data is lost and a later flip needs no new backfill. Do not delete mirror rows to roll back.

After the step 7 code is deployed there is no flag to flip: links written since then exist only in `entity_links`, so redeploying the previous
build (which reads the legacy tables when its flags are `off`, or `entity_links` when they are `on`) is safe only with every family's `*_READ`
still `on`. Keep those env vars set until the follow-up change (the 116 drop) is deployed AND has been run, then delete them (see
`entity-links-legacy-drop.md`, "Environment variables"). Once 116 has run, a rollback to a build that reads the legacy tables is impossible
without restoring the backup.

## What to verify, per family, before `on` (historical: done before step 7)

- Every writer mirrors in the same transaction as the legacy write (tasks: `lib/task-link-writes.ts`, including decision follow-through).
- Parity is 0 on real data, and a shadow soak shows no read-compare mismatches.
- Reader ordering: legacy readers are unordered; `entity_links` readers order by `createdAt, id`. Confirm no consumer depends on order.
- Task links to DECISION targets (REVIEW_REQUEST in `entity_links`) have been exercised on real data at least once, because a family with
  zero rows of a type proves nothing about that path.
