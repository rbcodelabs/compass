# ADR 0005 — Compass-Native Decision Gates and Immutable Decision Ledger

- **Status:** Accepted
- **Date:** 2026-08-31
- **Decision owner:** Rick Bowman
- **Scope:** Human decisions that authorize guarded Compass transitions, initially
  Roadmap admission to `NOW` and release authorization
- **Related:** Obsidian ADR-0004, “Explicit Human Authorization and Automated
  Release Lifecycle” (2026-08-30)

## Problem

Compass uses Tasks as its human review inbox, but it has no native, immutable
decision-record capability. For the Compass dogfood workspace, review requests
are therefore surfaced as Tasks while authoritative decisions are written to
Obsidian. This prevents a resolver from safely treating a Task status, comment,
or mutable Solution Plan status as authorization to move work into `NOW`.

ADR-0004 independently proposes a release-specific `ReleaseDecision`. Adding a
generic approval system beside it would create two answers to “what did the
human authorize?” The design must instead create one decision ledger while
preserving ADR-0004's stricter, SHA-bound release lifecycle.

## Constraints and success criteria

- A decision is an explicit human act, not an inferred Task, Roadmap, Solution,
  PR, or deployment state.
- Automation may prepare review packets and apply authorized continuations, but
  a service credential may not manufacture a human decision.
- The decision is bound to an immutable request revision and canonical
  fingerprint. A material change supersedes it rather than editing it.
- `NOW` admission and release authorization share record semantics, identity,
  idempotency, audit, and UI patterns; their eligibility checks and effects stay
  domain-specific.
- Release authorization remains bound to repository, PR, exact head SHA,
  environment, policy version, and sorted covered Task IDs as ADR-0004 requires.
- The initial design must fit Aurora DSQL: UUID keys, string discriminators,
  application-managed timestamps, no reliance on foreign-key enforcement, and
  additive/idempotent migrations.
- Existing UI actions and MCP tools currently permit direct Roadmap moves and
  Task completion. Guarded transitions must be centralized so UI, MCP, and
  automation cannot bypass the same invariant.
- Compass currently has only `MEMBER` and `ADMIN` workspace roles, with org
  owner/admin inheritance. The design must use the existing normalized role
  helpers rather than introduce a new RBAC system.

Done means a reviewer can inspect a stable packet, choose an option once, and
later prove which request revision, actor, role, rationale, and continuation
were authorized. A guarded domain operation accepts only a matching decision
and records an idempotent application receipt.

## Non-goals

- A generic workflow engine, approval DSL, voting/quorum system, or arbitrary
  user-defined automations.
- Replacing Tasks as the review inbox.
- Replacing GitHub checks, release manager, Vercel, or the delivery completion
  watcher.
- Treating Solution Plan `planStatus` as an immutable or authoritative gate.
- Automatically applying every decision. Each domain owns its continuation.

## Current architecture findings

- `RoadmapItem.horizon` is a plain string and all ordinary UI/MCP mutations can
  currently move an item directly to `NOW`; no commitment receipt exists.
- `Task.status` can move directly to `DONE`. A release-covered Task therefore
  needs the ADR-0004 completion guard in addition to this generic decision work.
- `SolutionComment.planStatus` is explicitly mutable, side-effect-free, and can
  be changed by agents. It is useful discussion context, not a decision ledger.
- UI authorization has reusable workspace/org-admin helpers. MCP authorization
  is centralized and fail-closed, but its trusted service actor currently has
  global access; decision-taking operations need a stricter human-actor rule.
- The MCP catalog validates inputs with Zod and has a completeness test requiring
  a gate for every registered tool. Mutating agent calls also receive a generic
  audit entry, which is useful telemetry but lacks decision semantics.
- Existing tests favor handler-level Vitest mocks, server-action auth tests,
  MCP schema/catalog tests, authorization-gate tests, and focused Playwright
  flows. The decision service should follow those seams.

## Options considered

| Option | Benefits | Costs / what it gives up |
|---|---|---|
| **A. One generic immutable decision ledger; domain-owned gates and continuations** | One source of decision truth; NOW and release share identity/audit semantics; release retains strict fingerprint and state machine; small reusable kernel | Adds several tables and requires centralizing formerly free transitions; each new gate still needs domain code |
| **B. Separate approval models per domain** (`NowCommitmentDecision`, `ReleaseDecision`, etc.) | Each schema is explicit and locally easy to understand | Competing semantics, duplicated auth/idempotency/UI, harder cross-domain audit, and likely drift over time |
| **C. Keep Tasks plus Obsidian as the permanent gate system** | Lowest immediate schema cost; preserves current routing | Task state is mutable, application is difficult to make atomic/idempotent, product cannot enforce gates itself, and every provider integration reimplements the contract |

## Decision

Adopt **Option A**: a small Compass-native decision kernel consisting of a
mutable review envelope, immutable revision/options, an append-only decision
record, and an idempotent application receipt. Domain services—not the generic
kernel—evaluate eligibility and apply effects.

Compass Tasks remain the human inbox. A Task may link to a Review Request, but
moving that Task to `DONE`, editing it, or commenting on it has no authorization
meaning.

### Conceptual records

| Record | Essential fields | Invariant |
|---|---|---|
| `ReviewRequest` | workspace, gate type, subject type/id, current revision ID, state, requested/assigned actor, due/expiry times | Mutable envelope only; never itself proves authorization |
| `ReviewRevision` | request, revision number, canonical fingerprint, title/summary, immutable packet JSON, required role, created time | Append-only; unique request + revision and request + fingerprint |
| `ReviewOption` | revision, stable action key, label, outcome class, continuation key, sort order | Frozen with its revision; options cannot be changed after publication |
| `DecisionRecord` | request/revision/option, fingerprint, human user ID, actor/role snapshot, rationale, idempotency key, decided time | Append-only; exactly one terminal decision per revision; no update/delete API |
| `DecisionApplication` | decision, domain continuation key, target type/id, status, receipt key, attempts/error, applied time | Unique decision + continuation; retries return the same receipt |

`packet JSON` is an immutable display/audit snapshot, not the authoritative
domain object and not executable instructions. Frequently filtered identifiers
and states remain normalized columns. Domain tables may store a nullable
`decisionRecordId` reference where fast invariant checks are required; because
DSQL uses application-level relations, the service validates workspace and
target ownership explicitly.

Suggested initial gate and action keys are deliberately closed sets in
TypeScript/Zod, stored as strings in DSQL:

```text
gateType: NOW_COMMITMENT | RELEASE_AUTHORIZATION
outcomeClass: APPROVE | REJECT | REQUEST_CHANGES | DEFER
continuationKey: ADMIT_ROADMAP_ITEM_TO_NOW | DISPATCH_RELEASE_RUN
```

Adding a gate type requires a named domain policy and applicator. The system
must not expose “run arbitrary continuation from JSON.”

### Shared decision invariants

1. The reviewer decides an exact `ReviewRevision.id` plus fingerprint and
   `ReviewOption.id`; the server reloads all three before insert.
2. The authenticated user must satisfy `requiredRole` using normalized workspace
   and inherited org roles. The decision stores the evaluated role snapshot.
3. MCP may expose read/prepare/apply operations to automation. A take-decision
   MCP operation, if provided, rejects the global service actor and accepts only
   a per-user API key whose user satisfies the role. The primary UI uses Auth.js.
4. A repeated request with the same idempotency key returns the original
   decision. A competing terminal response for the same revision loses the
   uniqueness race and returns the existing result.
5. Changes to material input create a new revision/fingerprint and mark the old
   revision superseded. Old decisions remain readable but cannot be applied.
6. Decisions are never updated or deleted. Corrections use a new revision and
   decision (or an explicit revocation decision where the domain permits it).
7. `DecisionApplication` is not another approval; it is an operational receipt
   proving that one domain continuation consumed one decision.

### NOW commitment specialization

The Roadmap service owns the `NOW` eligibility packet and effect.

The fingerprint includes at least workspace ID, Roadmap Item ID, source Solution
ID, opportunity ID, current investment-stage evidence/decision references,
owner, capacity inputs, portfolio-policy version, requested horizon, and any
declared displacement item. Missing required data produces no approvable
revision.

All paths entering `NOW`—board move, item creation, promotion from Solution or
Feedback, generic entity editing, and MCP handlers—must call one centralized
`admitToNow` domain operation. A bare horizon write fails with a link to the
pending review. The operation reloads the item and policy inputs, recomputes the
fingerprint, verifies an approved `ADMIT_ROADMAP_ITEM_TO_NOW` decision, changes
the horizon, and writes the application receipt idempotently. Moves out of
`NOW` remain ordinary corrective actions unless a later policy says otherwise.

Legacy `NOW` rows are not backfilled with invented approvals. They receive an
explicit provenance such as `LEGACY_UNGATED` (or are reported as such until a
native commitment is made).

### Release authorization specialization and ADR-0004 reconciliation

ADR-0004's release state machine, `ReleaseRun`, covered Task set, dispatch,
provider evidence, external-merge provenance, production verification, and
completion watcher remain unchanged.

Its proposed `ReleaseDecision` is replaced by a reference to the shared
`DecisionRecord` whose:

- `gateType` is `RELEASE_AUTHORIZATION`;
- option continuation is `DISPATCH_RELEASE_RUN`;
- immutable revision packet contains the human-readable release review packet;
- fingerprint is ADR-0004's canonical hash over workspace, provider/repository,
  PR, base, exact head SHA, target environment, policy version, and sorted Task
  IDs.

`ReleaseRun.authorizationDecisionRecordId` points to that record.
`ReleaseDispatch` points to the same decision and remains the durable outbox.
`ReleaseEvent` remains provider/state evidence. Thus there is one approval
truth, while release keeps the additional machinery justified by its risk.

The ADR-0004 action remains explicitly named **Approve & release**. It must not
be rendered as a generic “Approve” button merely because the persistence layer
is shared.

## Structured contracts required before implementation

The following contracts resolve details that cannot safely be left to handler
code. Each subsection records alternatives and the recommended minimum.

### A. Referencing an applied investment decision during the Obsidian cutover

| Option | Contract | Tradeoff |
|---|---|---|
| Copy the Obsidian decision into a native `DecisionRecord` | Import before preparing the NOW review | Creates two records that appear authoritative and can diverge |
| Store the Markdown path in the review packet only | The applicator trusts a string in JSON | Easy, but does not prove outcome, application, subject, or file integrity |
| **Typed external evidence reference (recommended)** | The revision cites the one configured authority and a content-addressed external record | Preserves one authority and gives Compass a stable, verifiable dependency |

Add an immutable `DecisionEvidenceRef` associated with a `ReviewRevision`:

```text
DecisionEvidenceRef
  id                    UUID
  reviewRevisionId      UUID
  evidenceType          BUILDING_INVESTMENT_DECISION
  authorityProvider     OBSIDIAN | COMPASS_NATIVE
  authorityRecordId     string       # e.g. DEC-...
  authorityLocator      text         # vault-relative path, or native record URI
  authorityChecksum     char(64)     # SHA-256 of canonical decision payload
  subjectType           SOLUTION
  subjectId             UUID
  decisionOutcome       APPROVE_BUILDING
  decisionSourceVersion string
  applicationStatus     APPLIED
  appliedAt             timestamp
  applicationReceiptId  string
  verifiedAt            timestamp
  verifierVersion       string
  createdAt             timestamp

  unique(reviewRevisionId, evidenceType, authorityRecordId)
  index(subjectType, subjectId, evidenceType)
```

The Obsidian adapter must parse the configured immutable decision-record format,
require a stable record ID, verify that the decision covers the exact Solution,
require `application_status: applied` plus a non-empty receipt/result and
`applied_at`, canonicalize the semantic fields, and calculate the checksum. A
Task completion or prose assertion is not accepted as investment evidence.

After cutover, `authorityProvider = COMPASS_NATIVE`, `authorityRecordId` is the native
`DecisionRecord.id`, and `authorityChecksum` is calculated from that immutable
record. A revision contains references from exactly one authority provider—the
provider resolved when the revision is published. Existing Obsidian records
remain external evidence forever; they are not reissued as native decisions.
If `pm-config.md` changes providers, pending revisions are superseded and
reprepared. This makes the cutover explicit and prevents dual authority.

### B. Canonical capacity source and snapshot semantics

| Option | Meaning | Tradeoff |
|---|---|---|
| Hours or story points per period | Sum estimates against team availability | False precision, mixed estimation scales, and substantial UI/setup for a solo team |
| Derive capacity only from `portfolio_policy.now_limit` | Every NOW item consumes one slot | Very small, but “capacity data” becomes indistinguishable from a policy limit |
| **Explicit focus-slot plan plus live reservations (recommended)** | Admin declares concurrent focus slots for a period; every NOW item initially reserves one | Understandable for solo/small teams, auditable, and does not require estimation theater |

Use one active `PortfolioCapacityPlan` per workspace and time period:

```text
PortfolioCapacityPlan
  id              UUID
  workspaceId     UUID
  periodStart     date
  periodEnd       date
  unit            FOCUS_SLOT
  availableUnits  integer > 0
  source           MANUAL
  createdById     UUID
  createdAt       timestamp
  supersedesId    UUID nullable

  unique(workspaceId, periodStart, periodEnd)
  index(workspaceId, periodStart, periodEnd)
```

Plans are append-only. At review preparation, the NOW policy creates an
immutable capacity snapshot inside normalized revision fields (and duplicates
it in packet JSON for display):

```text
capacityPlanId
capacityPlanFingerprint
periodStart / periodEnd
unit = FOCUS_SLOT
availableUnits
requestedUnits = 1
reservedUnits = count(active NOW items excluding declared displacements)
reservedRoadmapItemIds = sorted IDs
effectiveLimit = min(availableUnits, portfolioPolicy.nowLimit)
remainingUnitsAfter = effectiveLimit - reservedUnits - requestedUnits
```

The canonical live reservations are active Roadmap Items whose horizon is
`NOW`, not a mutable counter. `availableUnits` is explicit human capacity;
`nowLimit` is the portfolio WIP safety cap. Preparation blocks if no capacity
plan covers the requested commitment date, rather than inventing availability.
Overlapping active plan periods are rejected by the service (DSQL cannot express
an exclusion constraint here); a replacement references `supersedesId`, and the
superseded plan remains valid only for historical revision verification.
For v1, every item consumes exactly one focus slot and capacity is workspace
scoped; squads and variable weights are deferred.

**Product choice for Rick:** accept focus slots (one per NOW item) as the v1
meaning of capacity, and choose the first explicit `availableUnits` value for
the Compass workspace. The architecture recommends this over hours/points but
cannot truthfully choose Rick's real capacity.

### C. Stable portfolio-policy identity

| Option | Identity | Tradeoff |
|---|---|---|
| File path plus modification time | `pm-config.md@updatedAt` | Unstable across copies and changes for irrelevant whitespace |
| Incrementing version entered by a human | `portfolio-policy-v7` | Readable but can be forgotten or reused accidentally |
| **Schema-versioned content hash (recommended)** | Hash canonical semantic policy JSON | Deterministic across providers and changes whenever behavior changes |

Define the identity as:

```text
portfolioPolicyId = "portfolio-policy:v1:sha256:" + SHA256(canonicalJson)
```

`canonicalJson` includes every behavior-affecting key with defaults expanded,
keys sorted, arrays normalized where order is not semantic, and integers kept as
integers: `now_limit`, `next_limit`, `concurrent_validation_limit`,
`require_validated_solution_for_next`, `require_displacement_when_full`,
`require_owner_for_now`, and `require_capacity_data_for_now`. It excludes file
path, comments, timestamps, and unrelated PM config. The parser/canonicalizer
has an explicit schema version (`v1`) and test vectors. The full canonical JSON
is stored in the revision packet; the ID is stored in a queryable column and
participates in the NOW fingerprint.

When policy authority later moves into Compass, the same canonicalizer is used.
A semantic policy change supersedes every pending NOW revision prepared under
the prior ID.

### D. Displacement target and atomic move semantics

| Option | Effect when NOW is full | Tradeoff |
|---|---|---|
| Reject until a user manually frees capacity | Two actions and a race between them | Simple backend, poor approval packet, not atomic |
| Move the displaced item to `LATER` | Strong decommitment | May overstate the decision; loses near-term intent |
| **Explicitly move one named item to `NEXT` in the same transaction (recommended)** | Swap one focus slot | Matches “committed next” semantics and is reviewable/all-or-none |

For v1, a NOW request contains either no displacement or exactly one
`displacementRoadmapItemId`. It is required when
`reservedUnits + requestedUnits > effectiveLimit`, and forbidden otherwise.
The displaced item must be an active `NOW` item in the same workspace, must not
be the candidate, and must not be in `LAUNCHING`/`LAUNCHED`. The revision packet
captures its ID, title, source fingerprint, and destination `NEXT`.

The NOW source fingerprint includes the ordered current NOW set, candidate ID,
capacity snapshot, policy ID, and displacement tuple
`(itemId, sourceHorizon=NOW, destinationHorizon=NEXT)`. Application performs one
DSQL interactive transaction:

1. Reload candidate, displacement, capacity plan, policy, and current NOW IDs.
2. Recompute and compare the exact fingerprint.
3. Verify the approved Decision Record and absence of an application receipt.
4. Move the displacement to the end of `NEXT` using current max `sortOrder`.
5. Move the candidate to the freed `NOW` position (the displaced item's former
   `sortOrder`, avoiding an unnecessary reorder of the remaining NOW column).
6. Insert the `DecisionApplication` receipt.

Any mismatch aborts the transaction and supersedes/reprepares the review; no
partial move is legal. DSQL does not enforce foreign keys, so every row is
revalidated for workspace ownership inside the transaction. The service uses a
bounded transaction retry for serialization conflicts and the receipt key for
ambiguous post-commit recovery.

**Product choice for Rick:** confirm that a displaced NOW item lands in `NEXT`.
If displacement means cancellation in the intended product language, choose
`LATER` instead; the destination must be visible in and fingerprinted by the
approval packet, never inferred during apply.

### E. Reopening or correcting a terminal review with the same source
fingerprint

| Option | Behavior | Tradeoff |
|---|---|---|
| Reopen the terminal revision | Clear/change its terminal state | Violates append-only audit semantics |
| Forbid reconsideration until source data changes | Same fingerprint can never be reviewed twice | Blocks correction of a mistaken reject/defer |
| **Create a new decision cycle and revision (recommended)** | Preserve source fingerprint; change review identity | Slightly more records, complete audit |

`ReviewRequest` gains monotonically increasing `decisionCycle`. A revision has
both `sourceFingerprint` (domain inputs) and `reviewFingerprint`:

```text
reviewFingerprint = SHA256(
  requestId + decisionCycle + revisionNumber + sourceFingerprint
)
```

A terminal `REJECT`, `DEFER`, expired, or cancelled review may be reopened only
by `startNewDecisionCycle(requestId, reason, expectedTerminalDecisionId)`.
This increments the cycle and publishes a new revision even when the source
fingerprint is identical. The prior Decision Record remains terminal and linked
as `reconsidersDecisionId`; the new request records `reopenReason` and actor.
There is never more than one pending revision for a request.

An approved but unapplied decision is not silently reopened. The domain must
record a named revocation/correction decision in a new cycle, and the applicator
checks it immediately before action. Once applied, correction is a new domain
action (for NOW, move out through an explicit correction flow; for release,
rollback/revert if still possible), never deletion or mutation of the receipt.
Repeated submission in the same cycle remains idempotent and returns the
existing terminal decision.

### F. Minimal release schema for shared-ledger integration

Three approaches were considered: store release scope only in review JSON
(insufficient for correlation and state), implement ADR-0004's entire event and
deployment model before authorization (safe but delays the first useful slice),
or add the minimal normalized run/scope/outbox now and extend evidence tables in
the release slice. Use the third approach.

The minimum additive DSQL-compatible contract is:

```text
ReleaseRun
  id                            UUID
  workspaceId                   UUID
  provider                      GITHUB
  repositoryOwner               varchar(255)
  repositoryName                varchar(255)
  pullRequestNumber             integer
  baseRef                       varchar(255)
  headSha                       char(40)
  targetEnvironment             PRODUCTION
  releasePolicyId               varchar(160)
  sourceFingerprint             char(64)
  state                         PREPARING | READY_FOR_APPROVAL |
                                DECISION_RECORDING | DISPATCH_QUEUED |
                                DISPATCH_CLAIMED | BLOCKED | SUPERSEDED |
                                CANCELLED
  authorizationDecisionRecordId UUID nullable
  version                       integer default 0
  lastErrorCode                 varchar(100) nullable
  lastError                     text nullable
  createdById                   UUID nullable
  createdAt                     timestamp
  updatedAt                     timestamp

  unique(workspaceId, provider, repositoryOwner, repositoryName,
         pullRequestNumber, sourceFingerprint)
  unique(authorizationDecisionRecordId) # nullable; one decision authorizes one run
  index(workspaceId, state, updatedAt)
  index(provider, repositoryOwner, repositoryName, pullRequestNumber)

ReleaseRunTask
  id            UUID
  releaseRunId  UUID
  taskId        UUID
  createdAt     timestamp

  unique(releaseRunId, taskId)
  index(taskId, releaseRunId)

ReleaseDispatch
  id                      UUID
  releaseRunId            UUID
  decisionRecordId        UUID
  continuationKey         DISPATCH_RELEASE_RUN
  status                  PENDING | CLAIMED | SUCCEEDED | FAILED | CANCELLED
  idempotencyKey          varchar(255)
  claimedBy               varchar(255) nullable
  claimExpiresAt          timestamp nullable
  attemptCount            integer default 0
  runtimeRunId            varchar(255) nullable
  lastError               text nullable
  createdAt               timestamp
  updatedAt               timestamp
  completedAt             timestamp nullable

  unique(decisionRecordId, continuationKey)
  unique(idempotencyKey)
  index(status, claimExpiresAt, createdAt)
  index(releaseRunId, status)
```

`ReleaseRunTask` and all decision/run references are validated in application
code because DSQL migrations do not add foreign keys. `ReleaseRun.version` is a
compare-and-swap token. The authorization transaction reloads the PR scope,
matches the shared Decision Record and exact fingerprint, sets
`authorizationDecisionRecordId`, advances to `DISPATCH_QUEUED`, creates one
`DecisionApplication` with continuation `DISPATCH_RELEASE_RUN`, and creates one
`ReleaseDispatch`; retries recover via the two unique keys.

This minimum intentionally stops at dispatch. ADR-0004's append-only
`ReleaseEvent`, merge/deployment/verification evidence, external-merge
provenance, and final states (`MERGING` through `RELEASED`) are required before
the dispatcher may actually merge or Tasks may become `DONE`. They are not
smuggled into mutable JSON fields on `ReleaseRun`.

### Required service results and failure codes

The domain boundary returns typed results rather than freeform errors so UI,
MCP, and automation implement the same behavior:

```text
prepareNowCommitment(itemId, displacementItemId?, expectedPolicyId?)
  -> READY { requestId, revisionId, sourceFingerprint, reviewFingerprint }
   | BLOCKED { code:
       NO_APPLIED_INVESTMENT_DECISION |
       INVESTMENT_AUTHORITY_MISMATCH |
       NO_CAPACITY_PLAN |
       OWNER_REQUIRED |
       SOLUTION_NOT_VALIDATED |
       DISPLACEMENT_REQUIRED |
       INVALID_DISPLACEMENT |
       POLICY_CHANGED }

recordDecision(revisionId, expectedReviewFingerprint, optionId,
               rationale?, idempotencyKey)
  -> RECORDED { decisionRecordId }
   | EXISTING { decisionRecordId }
   | STALE_REVISION
   | TERMINAL_CONFLICT
   | FORBIDDEN_HUMAN_ROLE
   | SERVICE_ACTOR_FORBIDDEN

applyNowCommitment(decisionRecordId)
  -> APPLIED { applicationId, admittedItemId, displacedItemId? }
   | EXISTING { applicationId }
   | STALE_SOURCE
   | REVOKED
   | POLICY_OR_CAPACITY_CHANGED
   | RETRYABLE_CONFLICT

prepareReleaseRun(scope)
  -> READY { releaseRunId, requestId, revisionId, sourceFingerprint }
   | BLOCKED { code: INVALID_TASK_SCOPE | PR_NOT_READY | CHECKS_FAILED |
               POLICY_CHANGED }

queueAuthorizedRelease(releaseRunId, decisionRecordId,
                       expectedSourceFingerprint)
  -> QUEUED { dispatchId }
   | EXISTING { dispatchId }
   | STALE_SOURCE
   | REVOKED
   | DECISION_SCOPE_MISMATCH
```

Every mutation accepts an explicit idempotency key at the transport boundary,
executes its invariant reads and writes in one transaction where they share a
database, and performs ambiguous-commit recovery by reading the unique receipt
key before retrying. Provider reads (Obsidian/GitHub) occur before the database
transaction; their canonical checksums/identifiers are rechecked against the
published revision inside it.

```mermaid
flowchart LR
    T[Task review inbox] --> Q[ReviewRequest]
    Q --> V[Immutable ReviewRevision + options]
    H[Authenticated human] --> D[Immutable DecisionRecord]
    V --> D
    D --> N[NOW applicator]
    D --> R[ReleaseRun authorization reference]
    N --> RI[RoadmapItem NOW]
    R --> X[ReleaseDispatch]
    X --> RM[Release manager]
    RM --> EV[Release evidence + completion watcher]
```

### Lifecycle

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> PENDING: publish immutable revision
    PENDING --> DECIDED: terminal option recorded
    PENDING --> SUPERSEDED: material input changes
    PENDING --> EXPIRED: expiry reached
    PENDING --> CANCELLED: requester cancels
    DECIDED --> APPLIED: domain receipt succeeds
    DECIDED --> SUPERSEDED: input changes before apply
    DECIDED --> APPLICATION_BLOCKED: domain precondition fails
    APPLICATION_BLOCKED --> APPLIED: retry, same decision and fingerprint
```

For release, this shared lifecycle describes the authorization slice only;
`ReleaseRun` continues through merging, deploying, verifying, and released.

## Interface boundaries

Recommended service/API operations:

- `prepareReviewRequest(gateType, subjectId)` — domain policy builds/reuses a
  revision and its options.
- `getReviewRequest(id)` / `listReviewRequests(workspaceId, state, assignee)`.
- `recordDecision(revisionId, fingerprint, optionId, rationale,
  idempotencyKey)` — human-only mutation.
- `applyDecision(decisionId)` — dispatches to a registered domain applicator;
  safe for automation and retry.
- Domain convenience operations such as `requestNowCommitment(itemId)` and
  `approveAndRelease(runId, expectedFingerprint)` may compose the kernel but
  retain clear product language.

The MCP catalog should initially expose preparation/read/application tools, not
a service-key-capable approval shortcut. Every tool receives an explicit entry
in `mcp-tool-gates.ts`; review entities are added to `WorkspaceEntityType` for
workspace-scoped authorization. Decision-taking must use a dedicated gate that
requires a non-service actor and the revision's required role.

## Migration and rollout

1. Add the generic records and read-only review surfaces. Keep Obsidian as the
   configured authoritative provider during verification.
2. Implement `NOW_COMMITMENT` preparation, human decision, and centralized
   `NOW` applicator. Block every direct entry path to `NOW` only after migration
   inventory and tests prove coverage.
3. Implement ADR-0004 release tables/state machine using the generic
   `DecisionRecord` reference rather than a separate `ReleaseDecision` table.
4. Add an Obsidian export adapter that writes a human-readable mirror after the
   Compass transaction. The mirror is archive/reporting, not a second decision
   authority. Adapter failure is retried and visible but cannot alter the
   immutable Compass record.
5. Change `pm-config.md` `decision_records` from `obsidian` to the Compass-native
   provider only after contract tests demonstrate immutable reads, idempotent
   writes, role attribution, supersession, and application receipts. Existing
   Obsidian decisions remain authoritative historical records and may be
   referenced by external provider ID; do not fabricate native decisions.

This cutover is explicit. Dual-authoritative writes are forbidden.

## Verification strategy

- Schema tests for DSQL-compatible fields, indexes, and uniqueness constraints.
- Decision-service unit tests: authorized/unauthorized actor, service-actor
  denial, stale fingerprint, double submit, conflicting submit, supersession,
  expiry, immutable records, and idempotent application.
- NOW domain tests covering every existing ingress path (create, promote, board,
  server action, MCP, generic field mutation), legacy provenance, capacity and
  displacement changes, and transaction retry after ambiguous commit.
- Release contract tests for exact SHA/scope binding, changed fingerprint,
  revocation-before-claim, one dispatch, external merge provenance, production
  correlation, and `DONE` completion receipts.
- MCP Zod schema, catalog registration, structured output, fail-closed gate
  completeness, cross-workspace denial, and per-user versus service-key tests.
- UI server-action auth tests plus Playwright coverage for packet inspection,
  explicit action copy, concurrent/stale response, and live status display.
- Migration/backfill tests proving legacy `NOW` and historical Obsidian records
  are not relabeled as native approvals.

## Consequences

Compass gains one durable decision vocabulary and can become the configured
decision provider for its own workflows. Review UX and audit queries become
consistent across product and release gates, while domain teams retain explicit
control over eligibility and side effects.

The cost is that formerly permissive mutations must pass through domain
services, and Compass owns an append-only ledger plus provider-export retries.
The model intentionally does not solve multi-reviewer quorum; introducing that
later would require a policy layer over multiple Decision Records, not changing
the meaning of one record.

## Risks and revisit triggers

- **Riskiest assumption:** one human decision per revision is enough for the
  solo/small-team target. Revisit for separation-of-duties or quorum needs.
- Application-enforced immutability can regress if generic CRUD is generated for
  ledger tables. Keep them out of generic entity mutation paths and consider a
  restricted database role if compliance needs increase.
- JSON packets can become an accidental dumping ground. Keep policy-relevant
  fields normalized or fingerprinted and version every packet schema.
- Cross-workspace polymorphic IDs can be misbound without database FKs. Every
  prepare/read/apply path must resolve ownership and compare workspace IDs.
- A Compass-to-Obsidian mirror may look authoritative to humans. Mark exports
  with native decision ID, checksum, and `mirror: true` after cutover.
- Revocation semantics differ by domain: NOW can usually be moved out, while a
  claimed/merged release cannot be “unreleased.” Revocation remains a
  domain-defined option, not a universal state transition.

Revise this decision if product requirements demand multi-party voting,
cross-workspace gates, user-defined continuations, compliance-grade database
immutability, or release trains. None is required for the present problem.
