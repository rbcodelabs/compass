# 115 entity_links task link move: COMMENT and AGENT_CONVERSATION

Migration `115_entity_links_task_link_move` (hook: `lib/migrations/entity-links-task-link-move.ts`). No DDL, explicit-only, insert-only.

Why: the nine association kinds of `task_links` moved into `entity_links` (`TASK_REFERENCES`) with migration 097. Two kinds were never
mirrored: **COMMENT** (the comment a task was made from) and **AGENT_CONVERSATION** (the conversation whose `TaskCreate` tool made it).
They now live in `entity_links` as the internal link type **`TASK_CREATED_FROM`** (task -> `COMMENT` | `AGENT_CONVERSATION`), so the
`task_links` table can be dropped without losing them. The external behavior is unchanged: the task screen, `list_task_links`, comment
thread sync, comment task cards and the agent's plan card show the same links.

## What the migration does

- Source: `task_links` rows with `linked_type IN ('COMMENT', 'AGENT_CONVERSATION')`.
- Target: `entity_links` `TASK_CREATED_FROM`, `from_type = TASK`, `to_type` the same word, origin `MIGRATION`, workspace = the task's.
- Copied from the legacy row: **`id`** (so an id an open page holds for the link survives), `source`, `created_by_id`, `created_at`.
- **Insert-only.** Nothing in `task_links` or `entity_links` is changed or deleted (links made after the code deploy exist only in
  `entity_links`). The only update is a workspace/type repair of an existing `TASK_CREATED_FROM` row of a legacy pair.
- Batched at 500 rows (a link is 4 DSQL-modified rows against a 3,000-row cap), keyset-paged by `task_links.id`, anti-join on the unique
  pair index, no `ON CONFLICT`, no `SET LOCAL statement_timeout`, no advisory lock, no foreign key, no DDL. DSQL OCC conflicts retry.
- **Quarantined** (not copied, left in place, reported by id in the POST log and in the GET status): `dangling` (the task, comment or
  conversation is gone) and `crossWorkspace` (task and target in different workspaces, or a target with no workspace). No reader can show
  these links, so leaving them behind loses nothing a person could see. Resolving them is a human decision outside this migration.
- Idempotent and resumable. A failed postcondition leaves no receipt and a re-POST continues where it stopped.

Postconditions, proved BEFORE the receipt is recorded (each refuses the receipt with a message that names the failing check):

1. per type (`COMMENT`, `AGENT_CONVERSATION`): zero consistent legacy rows without a matching `TASK_CREATED_FROM` row (pair-set equality, workspace and type included);
2. per type: the number of consistent legacy rows equals the number of `TASK_CREATED_FROM` rows covering them (row-count equality);
3. zero duplicate `(from, type, to)` pairs;
4. every `TASK_CREATED_FROM` row whose task and target exist carries the workspace_id of both.

A row whose endpoint vanished after the deploy (a deleted comment) is reported, never refused: readers already hide it.

## Order safety: deploy first, migrate after, nothing disappears in between

The code in this change no longer writes `task_links` and reads origin links from `entity_links`. It is deployed BEFORE this migration
runs, so for a while every origin link made before the deploy exists only in `task_links`. To keep those visible:

- **Reads** (`lib/task-links-read.ts`) merge `entity_links` with the not-yet-moved `task_links` rows (`readUnmovedTaskLinks` in
  `lib/legacy-link-tables.ts`), by pair, `entity_links` winning. That covers the task screen, `list_task_links`, comment thread sync,
  comment task cards, the "agents already assigned in this doc/target" lookups and the agent's plan card.
- **Writes** go to `entity_links` only. A repeat of a link that exists only in `task_links` returns that link instead of creating a copy.
- **Deletes** (unlink, comment delete, workspace delete) remove the pair from both stores, so the fallback cannot bring a removed link back.
- After the migration, the fallback finds only rows that already have a twin (same pair; the copy even has the same id), which the merge
  drops. The fallback is deleted together with `task_links`.

Covered by `__tests__/links/task-links-read.test.ts`, `__tests__/links/task-reference-links.test.ts` and, on real Postgres,
`__tests__/links/task-link-writes.integration.test.ts` ("deploy before migration 115").

## Operator steps

1. **Deploy** the code of this change (the preview/production deploy of the PR). Do nothing else yet. Links keep working through the fallback.
2. **GET** `/api/admin/migrate` (`x-migration-secret`; production credential per `CLAUDE.md`). Read `entityLinksTaskLinkMove`:
   - `types.COMMENT` / `types.AGENT_CONVERSATION`: `legacy` (all rows), `consistent` (copyable), `unmoved` (consistent and not yet copied), `entityLinks` (rows of the type already in `entity_links`);
   - `unmoved` (the sum) is what the POST will copy;
   - `quarantined.dangling` / `quarantined.crossWorkspace`: counts and up to 50 `task_links` ids each.
   Also confirm `115_entity_links_task_link_move` is listed as pending and skipped as explicit-only on an untargeted run.
3. Pick a quiet window if `unmoved` is large (roughly one committed batch of 500 per few hundred milliseconds on Postgres 16; `task_links` COMMENT/AGENT_CONVERSATION is a small subset of the table).
4. **POST** `/api/admin/migrate` with `{"script":"115_entity_links_task_link_move"}`. Never omit `script` while unrelated migrations are pending. The log names the inserted counts and every quarantined id. A `202` means resume: POST the same body again.
5. **GET** again. Expect `entityLinksTaskLinkMove.unmoved = 0` and `types.*.unmoved = 0`; `_prisma_migrations` shows the receipt.
6. **Parity.** In the same GET, `entityLinksReadParity.unmovedTaskOriginLinks` must be `0` (live `task_links` COMMENT/AGENT_CONVERSATION rows with no live `TASK_CREATED_FROM` twin), and `families.taskCreatedFrom.onlyLegacy` is `0`. `onlyEntityLinks` greater than 0 is normal: those are links made after the deploy, which have no `task_links` row.
7. **Application readback** on one workspace: open a task made from a doc comment and a task the agent made in a chat; both show their link in the task's Links section.

Rollback: there is nothing to undo. The migration only inserts; deleting the `TASK_CREATED_FROM` rows it wrote is not needed because the
previous deploy never reads them and `task_links` is untouched.

## Before `task_links` is dropped (the follow-up change)

- `entityLinksTaskLinkMove.unmoved = 0` and `entityLinksReadParity.unmovedTaskOriginLinks = 0` in production.
- The quarantined ids were reviewed (they are unreachable by any reader).
- The follow-up deletes `lib/legacy-link-tables.ts` task_links functions (`readUnmovedTaskLinks`, `findLegacyTaskLinkById`, `deleteLegacyTaskLinkPair`, `deleteLegacyTaskLinksTo`, `deleteFrozenTaskLinks`), their call sites in `lib/task-link-writes.ts` and `lib/task-links-read.ts`, the `TaskLink` model and the `Task.links` relation, and the `task_links` branches of `entity-links-read-parity.ts`.

## Explaining a specific row: `entityLinksRowDetail`

`GET /api/admin/migrate` also returns `entityLinksRowDetail`: read-only metadata (ids, types, workspace, timestamps, actor, source, origin, plus `fromExists`, `toExists`, `sameWorkspace`, `fromResolves`, `toResolves` and `wouldBeReturnedByTaskLinkReaders`; never a title or body) for at most 50 rows, with a `truncated` flag. It lists (1) every id named in `entityLinksReadParity.families.*.ids` (`parity` says which family and set) and (2) every task-owned `entity_links` row (the registry's link types whose `from` is TASK) that the task link readers would drop because an endpoint is missing or lives in another workspace (`hiddenTaskLink: true`). A parity id that names no `entity_links` row (a legacy id) is under `idsWithoutEntityLinksRow`. It touches only `entity_links` and the entity tables, so it keeps working after `task_links` is dropped; a failure is reported as the block's own `error` and never fails the GET.
