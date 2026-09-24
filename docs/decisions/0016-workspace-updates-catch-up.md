# ADR-0016: Workspace Updates and explicit catch-up state

**Date:** 2026-09-23
**Status:** Accepted for MVP implementation; production rollout requires separate authority

## Context

Returning workspace members need to understand what progressed, what was learned,
and what needs a decision in about two minutes. The approved Updates prototype
establishes grouped cards, expandable supporting activity, a past-week view,
explicit Mark caught up, and Undo. Approval and delivery references are retained
in the private product workspace, not in this public architecture record.

Compass uses Next.js, Prisma and Aurora DSQL. UI actions, inline entity edits,
MCP handlers and several shared services mutate product records. There is no
single business mutation service. `updatedAt` describes current records, not a
history of changes; child writes do not reliably update their parent. Agent tool
logs describe execution attempts and omit human activity and business semantics.

The MVP must preserve existing authorization, capture actual changes from both UI
and MCP, and never silently mark an arriving or unloaded update as read. It must
also survive deployment before its additive migration has been applied. Expected
initial use is one small dogfood workspace; no high-throughput event pipeline,
new vendor, cross-workspace feed, subscriptions, notifications or AI summaries.

## Decision

### Capture and ordering

Add an append-only workspace event table and a per-workspace revision counter.
Use UUID primary identifiers and a workspace-scoped integer revision for order.
A covered mutation reads its prior business state, applies its write, increments
the workspace counter and inserts its event in **one transaction**. A no-op
status assignment emits no event. A failure rolls the whole transaction back;
never catch an event insert failure after committing the business mutation.

Expose a small explicit helper accepting the transaction client, validated
workspace, authenticated actor, event kind, entity/group references and bounded
before/after enum metadata. Call it from covered services/entry points rather
than installing a global Prisma interceptor. Existing transactions must pass
their client through; do not open nested transactions or use the singleton from
inside the helper. Keep external calls and cache invalidation outside retryable
transactions. Retry only recognized rollback/optimistic-conflict failures, with
a bounded attempt count and jitter; never blindly retry ambiguous commit/network
failures. Preserve existing idempotency contracts, particularly decisions.

Serializing event allocation through one workspace row is deliberate: timestamps,
UUIDs and allocated sequence numbers alone do not guarantee commit order. A
transaction that started before catch-up could otherwise commit afterward below
the read watermark and disappear unread. Counter contention is a cost we accept
for the initial volume, not a general-purpose high-throughput architecture.

Store typed metadata and references, not copies of comment bodies, evidence,
decision rationales or credentials. Render titles and actor display names from
current authorized records in bounded batches. Use truthful actor types:
human, registered agent, service or system; do not invent a person for service
credentials. Metadata-only events cannot preserve historical renamed titles;
that is an explicit MVP tradeoff.

### Capture matrix

Engineering must enumerate and test actual entry points implementing each row.
An uninstrumented path is a documented gap, not evidence of complete coverage.

| Event family | Capture rule | Integration surfaces to inspect |
|---|---|---|
| Tasks | Creation and actual status changes, including cancel | Task actions, linked-task creation, task MCP handlers, inline entity mutations |
| Discovery | Opportunity, solution and assumption creation/status changes | Discovery actions, dedicated MCP handlers, inline entity mutations, decision application paths |
| Roadmap | Creation, horizon/delivery transitions | Roadmap actions and launch actions, MCP handlers, inline edits, shared delivery transitions |
| Experiments | Creation, start/status changes, result creation, conclusion | Experiment actions, MCP create/update paths, inline edits |
| Evidence | New evidence attached to a supported target | Discovery actions, evidence handlers, research evidence promotion if included |
| Decisions | Actual recorded decisions; proposals distinguish pending from decided | Shared decision recording and proposal/comment services, preserving replay semantics |
| Discussion | New nonempty root comments; explicit solution plans labeled as proposals | Shared comments and legacy compatibility entry points; exclude replies, edits, migration imports |

Exclude ordinary title/description autosaves, sorting, read calls and repeated
status assignments. Root-comment selection is the deterministic MVP proxy for
substantive discussion; it makes no claim to understand comment importance.
Docs/artifact revisions, research session internals, OKR check-ins and feedback
triage are not implied by this matrix. The UI/help page must name final coverage
and the point at which capture began. Never backfill fabricated historical
transitions from current timestamps. The five prototype stories remain examples;
they are not hardcoded production feed data.

### Grouping and presentation

Sort cards newest-first by their latest eligible event revision. Group by an
explicit direct parent/reference: child tasks use their parent task, root tasks
use themselves; experiment results use their experiment; comments/proposals use
their target; evidence uses its explicit target. Discovery items may use their
direct parent, but do not recursively merge an entire opportunity tree. A task's
many-to-many links are not a canonical parent. Record the selected group reference
at event time and fall back to the live source if the parent disappears.

Use deterministic headlines describing the latest transition, counts and links.
Expandable details show individual events. An old completion followed by a
reopening must not produce a current "shipped" claim. Repeated work on the same
group after catch-up yields new unread activity; no mutation of prior event text
or automatic read state change is necessary. Current names may change without
producing a new card.

### Snapshot, pagination and read state

Read the workspace revision and feed rows in a consistent transaction snapshot.
Use that upper revision for the entire browsing session and keyset pagination.
Bound database reads and response sizes (for example, 100 events per page), with
explicit continuation. When a group spans pages, merge details by event ID and
never suggest its partial count is complete. Batched entity resolution avoids
one query per event. Suppressed/deleted events still advance pagination, so a
page of hidden records cannot cause an infinite loop.

Persist one read-state row per workspace and authenticated user with a caught-up
revision and a fresh random version token. First visit defaults to the prior
seven days; persist a baseline/window start so repeated visits do not silently
age unread records out. Past week is a browsing filter, independent of read state.

Only offer global Mark caught up after every eligible card in the selected
unread snapshot has loaded. If older unread cards remain outside a past-week
filter or a page cap, load them before making that global claim. Opening the page
or expanding a card never writes read state. Mark advances to the loaded snapshot
revision, never backward, and returns the previous revision and a receipt/version.
Every mark rotates the version, even when the requested revision is unchanged.
Events committed afterward have higher revisions and remain unread.

Undo must be a server-validated compare-and-swap on the precise mark receipt and
resulting revision. Restore the stored prior revision only if that receipt is
still current, then rotate the version again. A later mark in another tab/device
invalidates the first Undo. Do not trust a client-supplied arbitrary prior value;
store it with the receipt or sign the receipt with existing appropriate server
facilities. Expired/stale Undo returns a visible conflict and refreshes state.

### Authorization, deletion and lifecycle

Every read, pagination and catch-up request resolves workspace membership using
existing permissions. Every state write derives user ID from the session.
Source IDs, snapshot cursors, receipt values and metadata are untrusted input.
Bind cursors/receipts to workspace and user; validate ranges against server state.
Use the same entity visibility rules as source pages; workspace membership alone
must not expose a more restricted source. Suppress events for deleted or now
inaccessible source records and descendants, and never expose a copied body or
dead source link. Resolve missing actors to a neutral label. Workspace deletion
must explicitly remove events, counter and read states; user cleanup removes
personal read state. DSQL does not provide database foreign-key cascades here.

### Migration and deployment

Use the registered migration runner and exact migration name. Add only new
tables/indexes; UUID identifiers, plain supported columns, no database enum or
trigger dependency. Execute one DDL statement per step and use separate async
index creation with completion verification. Index workspace/revision and the
unique workspace/user read-state key; avoid speculative indexes. Keep row counts
and payloads below DSQL transaction limits.

Roll out schema before enabling capture/landing-page behavior. Make capture
activation explicit and default off until migration verification. If capability
probing encounters specifically missing Updates tables, show an unavailable/
initializing state and preserve existing business mutations and workspace entry.
Do not turn arbitrary database outages into an empty "caught up" feed. Once
capture is enabled, event failures roll back covered writes and surface a
retryable error; never silently skip recording. A missing-schema fallback must
be decided **before** starting the business transaction, not by retrying a
possibly committed operation without capture. Production rollout is separate
from this build/PR authorization.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Query current records by updatedAt | Minimal schema/work | Cannot reconstruct transitions, misses child writes, no trustworthy unread semantics |
| Timestamped append-only events plus read timestamp | Explicit history, decentralized writes | Late commits can disappear below a watermark; exact read receipts add separate complexity |
| Transactional events plus workspace revision (selected) | Atomic capture, precise snapshot and Undo, no new infrastructure | Explicit integrations, workspace write contention, migration required |

A global database interceptor was also rejected: it lacks reliable actor,
authorization and business meaning, risks nested transaction mistakes, and turns
ordinary autosaves into noise. A future high-volume design may use immutable
event receipts or an ordered publication/outbox layer rather than one counter.

## Consequences

Users receive a concise inspectable feed with explicit completion, and engineers
can test every captured event against the mutation that caused it. We give up
semantic importance ranking, historical reconstructed narratives and comprehensive
platform coverage in the first release. Adding a new mutation path requires
updating the capture matrix and tests. The feed is not an audit log.

## Risks and verification

The riskiest assumption is that the bounded event selection is both useful and
complete enough for catch-up. Dogfood for a week; inspect missing milestones,
repetitive root comments and misleading group headlines before broad rollout.
Revise grouping if users cannot explain progress, learning and pending decisions
after two minutes. Revisit the counter if workspace transaction conflicts or
write latency become material.

Required tests cover: UI/MCP parity per capture row; before/after no-op suppression;
atomic rollback on event failure; counter conflicts; failed/denied writes producing
no events; late concurrent arrivals; frozen paginated snapshots; groups split
across pages; first-visit baseline; past-week filtering with older unread records;
reload persistence; same-revision cross-tab mark invalidating Undo; forged receipt
and cross-workspace denial; deleted/inaccessible source suppression; missing schema
versus other database failures; and desktop/mobile/keyboard behavior matching the
approved Artifact. Migration and preview smoke verification precede PR completion.
