# ADR-0007: Shared Comments and Decision Boundaries

**Date:** 2026-09-04
**Status:** Accepted

## Context

Compass had separate Solution and Doc comment tables while major product objects and tracked decisions lacked a common discussion model. Tracked decisions also introduced immutable revisions, outcomes, and application receipts whose authority must not be confused with mutable conversation.

Aurora DSQL does not enforce the polymorphic foreign keys needed for one comment type spanning thirteen object types. Existing Doc anchors and Solution plan metadata must survive migration, and the deployment must remain app-code rollback-safe.

## Decision

Use one mutable `Comment` core with a closed application-level target registry. Store Doc anchors and Solution plan proposal metadata in one-to-one extension tables. Threads are one level deep and replies must share their root's exact workspace and target.

Only a `ReviewRequest` aggregate with `gateType=TRACKED_DECISION` is commentable. Review revisions/options, Decision records/applications, legacy review gates, and release authorization remain immutable and uncommentable. Comments are discussion only; a Decision record's outcome and rationale remain authoritative.

The first migration is additive. It preserves legacy IDs, authors, timestamps, status, topology, anchors, and plan-status context while leaving both legacy tables in place. Compatibility paths keep the current UI behavior. A rollback therefore reverts application code without dropping or reconstructing data.

## Options Considered

| Option | Pros | Cons |
|---|---|---|
| One wide polymorphic table | Simple reads | Sparse fields mix discussion, anchors, and plan semantics |
| Shared core with extensions | Common identity and threading; specialized behavior stays explicit | Requires application-enforced referential integrity and ordered cleanup |
| Facade over three independent stores | Lowest initial migration effort | Preserves drift and provides no durable shared identity |

## Consequences

Generic clients can discuss all supported objects consistently. Doc anchors and Solution plans retain typed metadata. All creation and deletion must go through the centralized service because the database cannot enforce target ownership or cascading cleanup. New target types require an explicit registry addition and tests.

## Risks

An application path bypassing the service could create an orphan or cross-workspace comment. Compatibility drift is mitigated through deterministic backfill validation and dual-write adapters until legacy storage is retired in a later, separately reversible change.
