# 116 entity_links legacy drop: task_links, artifact_links, opportunity_objective_links, solution_key_result_links, opportunities.linked_key_result_id

Migration `116_entity_links_drop_legacy_tables` (hook: `lib/migrations/entity-links-legacy-drop.ts`). **IRREVERSIBLE. Explicit-only. Never run
without the owner's explicit go after the soak.** An untargeted POST skips it.

It drops, in this order, one statement per transaction (`IF EXISTS`, so a half-finished run resumes):

1. `DROP TABLE task_links`
2. `DROP TABLE artifact_links`
3. `DROP TABLE opportunity_objective_links`
4. `DROP TABLE solution_key_result_links`
5. `ALTER TABLE opportunities DROP COLUMN linked_key_result_id`

`entity_links` has been the only link store since #547 and migration 115 moved the last two task-link kinds, so no code reads or writes any of
these any more. **A dropped table cannot be restored by this application.** The only way back is the backup of step 3 (or a database-level
backup / point-in-time restore), and even that restores data, not code (see "Rollback limits").

## What is checked before anything is dropped (the preflight)

The `.sql` file contains no executable statement; the DDL is issued by the hook only after a read-only preflight passes. Any failure throws,
names the failing check, **drops nothing and records no receipt**. It is evaluated on every GET (`entityLinksLegacyDrop` in
`GET /api/admin/migrate`: `ready`, `blockers`, `notes`, `present`) so the verdict is readable before the POST.

| Check | Blocks the drop when |
|---|---|
| Receipts | `091_entity_links` or `115_entity_links_task_link_move` has no finished receipt |
| Parity (per family that still has its legacy source) | any **live** legacy pair has no `entity_links` row (`onlyLegacy` > 0). `entity_links`-only rows are fine (links made after the cleanup have no legacy twin). A legacy row whose endpoint is gone is not live, so it needs no twin |
| 115 | `entityLinksTaskLinkMove.unmoved` is not 0 |
| 113 | a consistent `AGENT_CONVERSATION` task link has no `CONVERSATION_CREATED` row (113 derives from `task_links` as well) |
| Unevaluable | the preflight itself errors (a timeout counts: it fails closed) |

Origin differences between the two stores (`originDrift`) are reported in `notes`, not blocking.

### Preflight failure modes and what to do

| Message | Meaning | Action |
|---|---|---|
| `migration 115_entity_links_task_link_move has no finished receipt` | 115 never ran here | Run the 115 steps (`entity-links-task-link-move.md`), then retry |
| `parity: N live <family> legacy row(s) have no entity_links row (legacy ids: ...)` | a legacy row exists that `entity_links` lacks. Two causes: (a) it was never moved (a backfill missed it); (b) the link was **removed after the cleanup** (#547): an unlink now deletes only the `entity_links` row and leaves the frozen legacy row of artifact, Solution-Key Result and Opportunity-Objective links behind | Look at the ids (read-only SQL below). If (b), the link is gone on purpose: the owner decides to delete exactly those legacy rows by hand, then re-GET. If (a), STOP: re-POSTing an applied backfill does nothing; a numbered residual migration is needed. Never "fix" it by weakening the preflight |
| `entityLinksTaskLinkMove.unmoved = N, must be 0` | consistent `COMMENT` / `AGENT_CONVERSATION` task links are not in `entity_links` | POST `115_entity_links_task_link_move` again (idempotent, resumes) |
| `entityLinksConversationBackfill.unmatched = N` | a conversation task link has no `CONVERSATION_CREATED` row | POST `113_entity_links_backfill_conversation` |
| `preflight could not be evaluated, nothing was dropped: ...` | timeout (15 s per family on plain Postgres) or catalog error | Retry off-peak; if it persists, investigate before anything else |
| `postcondition failed: still present after the drop` | a DDL statement did not take effect | No receipt was recorded. GET `entityLinksLegacyDrop.present`, POST again (resumes) |

Read-only SQL to inspect a legacy-only row (replace the schema; the parity ids are the legacy row ids):

```sql
SELECT 'solution_key_result_links' AS t, id, solution_id AS from_id, key_result_id AS to_id, created_at FROM "<schema>".solution_key_result_links WHERE id = ANY('{<ids>}'::uuid[])
UNION ALL SELECT 'artifact_links', id, artifact_id, linked_id, created_at FROM "<schema>".artifact_links WHERE id = ANY('{<ids>}'::uuid[])
UNION ALL SELECT 'opportunity_objective_links', id, opportunity_id, objective_id, created_at FROM "<schema>".opportunity_objective_links WHERE id = ANY('{<ids>}'::uuid[])
UNION ALL SELECT 'task_links', id, task_id, linked_id, created_at FROM "<schema>".task_links WHERE id = ANY('{<ids>}'::uuid[]);
```

## Order: deploy first, then run, then clean up

**Merging and deploying the PR is safe before the migration runs**: the tables stay until the explicit POST, and the code no longer reads them.
The code does depend on 115 (the deploy-before-115 read fallback is gone), so **115 must already have a receipt in a deployment before this
code is deployed there**; without it the pre-deploy COMMENT / AGENT_CONVERSATION links would be invisible until 115 runs (nothing is lost).
Authenticate every call with the `x-migration-secret` header (production credential: `COMPASS_PRODUCTION_MIGRATION_SECRET` in the agent
harness); never print it. Never omit `script` from a POST.

### rbcodelabs production (Supabase Postgres)

1. **Owner go.** The PR is a draft titled "DO NOT MERGE until owner go after soak". Do not merge before the soak and an explicit go.
2. **Merge and deploy** (production deploys carry `[deploy]` in the merge commit as usual). Wait for the deployment; the app keeps working with the tables still in place.
3. **GET** `/api/admin/migrate`. Record: `appliedMigrations` contains 115; `116_entity_links_drop_legacy_tables` is in `explicitOnlyPending`;
   `entityLinksLegacyDrop` = `{ ready: true, blockers: [] }`; `entityLinksReadParity.families.*.onlyLegacy` all 0 and `entityLinksTaskLinkMove.unmoved` = 0.
4. **Re-check the one open anomaly**: `entity_links` row `d8faeeb4-6fc0-4ac5-a6d7-f0ac7b9cc817` (`TASK_REFERENCES`, no `task_links` twin) is
   resolved or explained (it never blocks the preflight, which ignores `entity_links`-only rows, but it must be understood first).
5. **Backup, immediately before the POST** (a long gap lets new writes make it stale). Two equivalent options on plain Postgres:
   ```sh
   # A. the repository script (NDJSON + checksummed manifest; works on DSQL too). DATABASE_MIGRATION_URL = session pooler, port 5432.
   DATABASE_MIGRATION_URL=... npx tsx scripts/backup-legacy-link-tables.ts export --schema <schema> --out ~/backups/compass-116-$(date +%F)
   npx tsx scripts/backup-legacy-link-tables.ts verify --schema <schema> --out ~/backups/compass-116-<date>
   # B. pg_dump (data and DDL of the four tables, plus the column as CSV)
   pg_dump "$DATABASE_MIGRATION_URL" --no-owner --format=custom -t '<schema>.task_links' -t '<schema>.artifact_links' \
     -t '<schema>.opportunity_objective_links' -t '<schema>.solution_key_result_links' -f ~/backups/compass-116-<date>.dump
   psql "$DATABASE_MIGRATION_URL" -c "\copy (SELECT id, workspace_id, linked_key_result_id FROM \"<schema>\".opportunities WHERE linked_key_result_id IS NOT NULL) TO '~/backups/compass-116-<date>-pointer.csv' CSV HEADER"
   ```
   The export refuses (and a re-run is needed) if a table changes while it is read. Keep the output somewhere durable and private. The script is read-only; nothing in the repository runs it.
6. **POST** `{"script":"116_entity_links_drop_legacy_tables"}`. The log lists `✓ preflight clean`, each `✓ dropped ...` line and `✅ ... applied`. A `500` with
   `preflight refused, NOTHING was dropped` is a normal stop: fix the cause (table above) and POST again.
7. **GET** again: `appliedMigrations` contains 116, `entityLinksLegacyDrop` is `{ dropped: true, present: [] }`, and the `entityLinks*` status blocks report
   `legacyDropped: true` (none reports an `error`). A second POST of 116 is a no-op.
8. **Application readback** on a real workspace: a task's Links panel (add and remove a link), an Artifact's linked Solution, an Opportunity's
   Objective and Key Result links, a Solution's Key Result link, and delete a throwaway workspace or artifact.
9. **Then** remove the environment variables (below).

### Work deployment (Aurora DSQL), separately and on its own schedule

Everything above applies with that deployment's own URL, migration secret and database. Additionally:

- Run the **115 steps first** if 115 has no receipt there (it was run on rbcodelabs production only), and any of 095/096/097/098/106/113 that were
  never run there; the preflight lists exactly what is missing. Deploy this code only after 115 has a receipt.
- Backup with option A only (`PGHOST`, `PGUSER`, `PGDATABASE`, `AWS_REGION` and AWS credentials in the environment; an admin IAM token is generated).
- DSQL facts, checked against the AWS documentation (ALTER TABLE reference and the PostgreSQL-compatibility limits): `DROP TABLE` is supported;
  `ALTER TABLE ... DROP COLUMN [IF EXISTS]` is supported (primary-key columns excepted; the column is hidden, not physically removed, and keeps
  counting against the 1,600 lifetime column limit of `opportunities`); a transaction holds at most **one DDL statement** and DDL and DML need
  separate transactions (the hook issues each statement in autocommit and reads only before the first DDL); `DROP TABLE` needs no `ASYNC`
  and no job wait. Indexes on a dropped table go with it; indexes on the dropped column go with the column. The 3,000-row write limit
  does not apply to DDL. No `SET`/`statement_timeout` is used (DSQL rejects it).
- No separate DSQL-only migration was needed: DROP COLUMN is supported, so one migration serves both backends.
- Verify with the same GET and readback steps.

## Environment variables to remove (after the code is deployed)

No code reads any of these. Verified with `grep -rn COMPASS_ENTITY_LINKS_ lib app components scripts e2e` outside `lib/migrations/*` and
`prisma/migrations/*` (historical comments only) and the historical runbooks: the only hit is a test asserting the registry does **not**
mention them (`__tests__/links/registry-contract.test.ts`). `.env.example` no longer names them.

- `COMPASS_ENTITY_LINKS_SOLUTION_KR_MIRROR`, `COMPASS_ENTITY_LINKS_SOLUTION_KR_READ`
- `COMPASS_ENTITY_LINKS_OPPORTUNITY_MIRROR`, `COMPASS_ENTITY_LINKS_OPPORTUNITY_READ`
- `COMPASS_ENTITY_LINKS_ARTIFACT_MIRROR`, `COMPASS_ENTITY_LINKS_ARTIFACT_READ`
- `COMPASS_ENTITY_LINKS_TASK_MIRROR`, `COMPASS_ENTITY_LINKS_TASK_READ`

**Safe order:** deploy this code first, remove the variables after. Removing them earlier is harmless (the code that reads them has been gone since
#547) but keep the order so a rollback of the deploy stays valid until the variables are no longer needed. Do not touch Vercel as part of the PR;
this is an owner step. The work deployment has its own copy of the same variables and needs its own removal.

## Rollback limits (irreversible)

- **Reverting the PR restores code, not data.** The Prisma models, the readers and the migration come back; the dropped tables and the dropped
  column do not. The migration receipt stays, so a reverted build would query tables that no longer exist.
- Before the POST, nothing is irreversible: the tables are untouched by merge and deploy, and a revert of the PR is clean.
- After the POST, the only way back is restoring the backup: recreate the tables from the shipped migration SQL (`prisma/migrations/027_tasks`
  for `task_links`, `034_artifacts` for `artifact_links`, `071_typed_link_tables` for the two typed link tables, and
  `ALTER TABLE opportunities ADD COLUMN linked_key_result_id UUID`), then
  `npx tsx scripts/backup-legacy-link-tables.ts restore --schema <schema> --out <dir> --yes` (or `pg_restore` for the dump), and revert the code.
  Restored rows reflect the moment of the backup, not links made or removed since in `entity_links`.
- Also lost for good unless you restore: legacy rows that were never live (dangling or cross-workspace links nobody could see) and legacy-only rows you chose to delete before the POST. They survive only in the backup.
- **Soak requirement:** the owner gives an explicit go after a soak of the current `entity_links`-only code. Merge is not allowed before it.
- Local proof of the mechanism (throwaway Postgres 16, never a real database): `__tests__/entity-links-legacy-drop.integration.test.ts` (preflight
  refuses, drop, resume, rerun) and `__tests__/legacy-link-backup.integration.test.ts` (export, verify, tamper detection, restore).
