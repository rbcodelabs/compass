# ADR-0016: Experiment and research study relationships

**Date:** 2026-09-23
**Status:** Accepted — user-approved implementation plan

## Context

An experiment describes a hypothesis and how to evaluate it; research studies
organize participant sessions that may inform that evaluation. Without a
structured relationship, people must discover their connection in prose and
cannot navigate reliably from an experiment to its studies or back.

An experiment can require follow-up studies, and one study can inform several
experiments. Compass already supports authenticated workspace operations through
UI and MCP. Its Prisma schema uses `relationMode = "prisma"` with Aurora DSQL,
so application code must enforce tenant integrity and permanent deletion order.
Internal `PM_INTERVIEW` studies have different ownership semantics from ordinary
customer interviews and usability studies.

Success means members and authorized agents can link existing records, navigate
both directions, and unlink them without changing the study protocol or claiming
that any experimental assumption has been validated.

## Decision

Introduce an explicit `ExperimentResearchStudyLink` join model rather than an
experiment field on a study or an extension of the artifact relationship model.

- Store a UUID identifier, workspace ID, experiment ID, study ID, creation time,
  nullable creator ID, and source using existing schema conventions.
- Enforce uniqueness of `(experimentId, studyId)`. Index workspace cleanup and
  reverse study lookup. The pair index serves experiment lookup; do not add a
  redundant experiment-only index.
- Share read, link, and unlink operations between authenticated server actions
  and MCP handlers. Verify membership and resolve both endpoints within the
  declared workspace. Trusted service actors may bypass membership, never
  endpoint workspace validation.
- Permit ordinary `CUSTOMER_INTERVIEW` and `USABILITY_TEST` studies only. Exclude
  `PM_INTERVIEW` records from candidates, mutations, and relationship summaries.
- Allow every experiment status and draft, active, or closed studies. Exclude
  archived studies from new links, but retain existing archived links for
  display and removal. Active participant sessions do not prevent relationship
  changes because these are organizational metadata, not protocol edits.
- Make repeated link/unlink operations idempotent. Let the unique constraint
  arbitrate concurrent insertions and return an unchanged result for a duplicate.
  A failure unrelated to uniqueness must remain an error.
- Scope both join rows and resolved endpoints on reads. Omit dangling or
  ineligible targets, and project only IDs, titles/names, and lifecycle metadata
  needed for navigation. Do not expose participant tokens, transcripts, or
  participant access through an experiment.
- Respect the existing research feature flag. Disabled research must not break
  ordinary experiment reads; hide relationship UI and omit research summaries
  in that case. Relationship mutations require research to be enabled.
- Render reciprocal linked-record sections on the experiment panel, experiment
  full page, and study page using existing picker and status components. Refresh
  both directions after mutations. Distinguish duplicate titles in the picker.
- Add `link_experiment_to_research_study` and
  `unlink_experiment_from_research_study`, accepting `workspaceId`,
  `experimentId`, and `studyId`. Return identifiers and created/removed state
  through the existing result envelope. Classify these as OAuth and delegated
  agent writes, with both endpoint access checks. Restricted participant,
  PM-interview, and research-synthesis contexts receive no additional authority.
- Extend experiment and study getters additively with reciprocal summaries.
  Linking does not change experiment status/results, assumption validation,
  study status/protocol, or participant credentials.

Remove join rows before research studies during workspace cleanup. Ordinary
archiving retains relationships. Current permanent experiment deletion occurs
through workspace cleanup; any future individual deletion must first remove its
join rows. Tests with disposable linked records must follow the same ordering.

Use an additive registered migration without a backfill. Follow DSQL's existing
single-statement execution, asynchronous index waiting, rerun, and postcondition
patterns. Require table/index readiness before a successful migration receipt.
The table must exist before new relationship reads receive traffic. A code
rollback can leave the additive table and recoverable links in place.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| Explicit many-to-many join (chosen) | Typed endpoints; reciprocal queries; database duplicate protection; attribution follows existing models | Adds a table and migration; application owns integrity and cleanup |
| Nullable experiment ID on each study | Small schema addition; simple lookup | Prevents shared studies and needs a later migration to support the approved relationship |
| Prose URLs or a generic polymorphic link | No dedicated relationship model; flexible targets | Weak discoverability or type integrity; a generic subsystem exceeds this bounded feature |

## Consequences

Humans and agents see the same organizational context on both records. The
relationship supports study reuse without coupling research and experiment
lifecycles. We give up automatic conclusions, evidence promotion, and creation
of new studies from an experiment; those require separate product decisions.

No dependency, provider, ownership model, or participant workflow changes are
needed. The cost is an explicit migration and shared integrity checks that must
remain authoritative as new callers and deletion routes are introduced.

## Risks and Verification

The riskiest semantic assumption is that users understand a link represents
relevance, not successful validation. UI copy and documentation should preserve
that distinction, and tests must prove unrelated statuses, results, and study
protocol remain unchanged.

Security verification must cover unauthenticated calls, nonmembers, two
workspaces accessible to one actor, trusted service actors, read-only OAuth,
restricted agent contexts, and excluded PM interviews. Validate read projections
and archive behavior as well as mutations.

Exercise concurrent duplicates and retries, the registered migration twice,
postconditions, and workspace cleanup with linked records. Verify a complete
link → study navigation → reciprocal link → unlink journey, including the
experiment full page, keyboard access, desktop/mobile layouts, and recoverable
errors. Revisit this decision if links need immutable evidence snapshots,
cross-workspace sharing, or automatic experiment conclusions.
