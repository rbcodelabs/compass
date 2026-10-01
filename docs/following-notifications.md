# Following and in-app notifications (engineering notes)

The decision record is the ADR "Following and in-app notifications" in Compass
Docs (workspace `rbcodelabs/compass`, under Architecture Decisions). This file
only records how the code is laid out and what slice 2 must know. Do not add ADR
files to `docs/decisions/`.

## Status

Slice 1 (data model and infrastructure) is implemented and **dark**: nothing is
user-visible and nothing is wired to a mutation yet. Everything is gated by
`FOLLOWING_ENABLED=1` and by the registry slice gate
(`followableConfig.shippedSlice` in `lib/followable.ts`, currently 1, so no
subject type is active).

| Piece | Where |
| --- | --- |
| Tables and indexes | `prisma/migrations/068_follows_notifications/` (registered in `lib/migrations/runner.ts`, postcondition in `lib/migrations/follows-notifications.ts`) |
| Models | `Follow`, `Notification` in `prisma/schema.prisma` (no relations; DSQL has no FKs) |
| Flag and table-availability check | `lib/following-flag.ts` |
| Subject registry (workspace, display, access, slice, events) | `lib/followable.ts` |
| Follow, unfollow, auto-follow | `lib/follows.ts` |
| Emit (post-commit, best-effort), list, unread count, mark read | `lib/notifications.ts` |
| Cleanup helpers | `lib/follow-cleanup.ts`, called from the workspace cascade, `deleteWorkspace`, and member removal |

## Rules worth remembering

- `MUTED` is a tombstone. Unfollow keeps the row; `autoFollow` is insert-if-absent
  and never overrides any existing row. Only an explicit manual follow clears it.
- `emitSubjectEvent` runs **after** the source mutation commits, outside any
  transaction, and never throws. It returns `failed` and bumps a counter
  (`getEmitFailureCount`) instead. The unique `(recipientUserId, dedupeKey)` index
  makes a replay harmless.
- Payloads carry only `from`, `to`, `commentId`, `parentCommentId`. Titles are
  resolved at read time behind a membership and per-type access check.
- Cleanup helpers must not run inside a transaction: a missing-table (P2021)
  error would abort it.

## Slice 2 integration notes (from the transition-detection spike)

`lib/status-transitions.ts` now holds the pure "did a tracked field change" logic
that used to be inline in `captureWorkspaceMutation`. It is behavior-preserving
and has no dependency on `WORKSPACE_UPDATES_ENABLED`. Decoupling the adapter
itself from the Updates flag is slice 2 work, and these are the things that will
bite:

1. **`capture === false` currently means "do nothing extra".** The adapter skips
   the before-read, the actor lookup and the event write. Running detection when
   only Following is on must gate on `capture || followingAvailable`, or every
   site pays an extra read and an `auth()` call with both flags off. The test
   "leaves disabled writes untouched without requiring a new auth context" pins
   this and must keep passing.
2. **Without the Updates flag there is no transaction and no revision.** A
   non-atomic disabled write runs `callback(prisma, false)`, so the before-read is
   outside any transaction (benign for a best-effort notification, but the
   `dedupeKey` cannot use an Updates event id; use a hash of subject, from, to and
   the row's `updatedAt`).
3. **MCP tools run inside the PM receipt transaction** (`hasToolTransaction()`),
   so "after the adapter returns" is not "after commit" there. Slice 2 needs a
   commit-scoped queue (the `withActivityCommit` / `eventQueue` pattern in
   `lib/analytics/activity.ts`) so emits from MCP paths flush only once the outer
   transaction commits.
4. **Comments.** `createComment` is the single hook point (tail of the function,
   after `withWorkspaceUpdates` resolves). Its Updates capture skips replies;
   notifications must include them (`COMMENT_REPLIED`). `lib/comments.ts` will
   import `lib/notifications.ts`; `lib/followable.ts` therefore imports
   `resolveCommentTarget` lazily to avoid a cycle.
5. The slice 2 types are already wired through `captureWorkspaceMutation` (about
   60 call sites), so the adapter is a single seam for Task, Opportunity,
   Solution, Assumption, Roadmap item and Experiment. Feedback, OKR, Research,
   Metric and Decision status writes are slice 3.
