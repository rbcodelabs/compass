# entity_links rollout runbook

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
7. **Cleanup** (separate PR, only once every deployment you operate holds `on` on all families): remove the legacy readers and the
   read-flag switch.

## Residual drift

The runner never re-runs an applied migration, so re-POSTing an applied backfill does nothing. Rows written while a mirror flag was off
are picked up by a separately numbered, DDL-free, explicit-only residual that calls the same two exported functions. The existing one is
`106_entity_links_residual_opportunity`, which re-runs the 095 hook and postconditions under its own receipt. Add another residual (next
free number) rather than editing a shipped one.

## Rollback

Set the family's `*_READ` back to `shadow` (or `off`) and redeploy. Reads return to the legacy tables immediately; the mirror keeps
writing, so no data is lost and a later flip needs no new backfill. Do not delete mirror rows to roll back.

## What to verify, per family, before `on`

- Every writer mirrors in the same transaction as the legacy write (tasks: `lib/task-link-writes.ts`, including decision follow-through).
- Parity is 0 on real data, and a shadow soak shows no read-compare mismatches.
- Reader ordering: legacy readers are unordered; `entity_links` readers order by `createdAt, id`. Confirm no consumer depends on order.
- Task links to DECISION targets (REVIEW_REQUEST in `entity_links`) have been exercised on real data at least once, because a family with
  zero rows of a type proves nothing about that path.
