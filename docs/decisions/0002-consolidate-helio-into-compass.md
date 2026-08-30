# ADR-0002: Consolidate Helio Research Capture into Compass

**Date:** 2026-08-30
**Status:** Accepted

## Context

Compass owns the downstream product-discovery system: feedback, opportunities,
solutions, experiments, evidence, and roadmap decisions. Helio separately owns
upstream qualitative-research capture. Keeping both products creates duplicate
infrastructure and breaks provenance between interviews and the decisions they
inform.

PR #118 (`codex/capture-integration`) establishes the first Compass-native chat
study slice. It intentionally does not complete the transition. It also exposes
contracts that must change before production: participant-controlled agents can
read broad workspace data, the browser can rewrite the transcript, research MCP
credentials do not truly expire, and public routes lack production abuse controls.

The observed Helio production inventory contains one empty discovery project,
zero interviews, turns, or syntheses, and two orphaned Blob objects. Retained
logs show no participant-route traffic, but they cannot prove the participant
token was never distributed.

## Decision

Compass is the sole long-term product and system of record for research capture.
Helio will be retired through an incremental strangler cutover after Compass has
verified capability parity and production behavior.

The transition uses these invariants:

1. Public research agents have no workspace-wide Compass context. Any future
   internal context must be explicitly selected for a study and sanitized.
2. The server owns the ordered transcript. Participant and interviewer turns are
   persisted incrementally with idempotency and concurrency controls; completion
   never replaces transcript history.
3. Participant links use a first-class token model with hashes at rest, study
   scope, expiry, revocation, last-use tracking, and a legacy-Helio token kind.
4. Research MCP credentials expire independently of best-effort revocation.
5. Attachments and audio use first-class private records with durable Blob
   pathnames, MIME type, size, checksum, and exact session/turn provenance.
6. Syntheses are versioned. Findings and promoted Evidence cite exact source
   turns or attachments, and promotion always requires human review.
7. Voice and guided usability are transports over the common study, session,
   turn, and attachment domain—not parallel research subsystems.
8. DSQL changes remain additive. Import is dry-runnable, idempotent, and
   reconciled by source/target counts and Blob checksums.
9. Helio remains recoverable until migration, redirects, production smoke tests,
   and an observation window all pass. Its repository is archived, not deleted.

## Delivery sequence

1. Harden PR #118: token and credential expiry, server-authoritative incremental
   transcripts, workspace authorization, limits/rate controls, abandonment and
   resume behavior, and a real deployed Agent SDK interview with no Compass MCP
   server attached to the public interviewer.
2. Add researcher review, editable AI guide generation, session summaries,
   lifecycle controls, and Compass MCP study/result workflows.
3. Add versioned synthesis, source-linked finding review, and Evidence promotion.
4. Add guided usability and private attachments.
5. Add Realtime voice over the canonical transcript domain.
6. Export/inventory Helio, reconcile an idempotent import or archive-only
   disposition, preserve or expire legacy links deliberately, and run a final delta.
7. Make Helio read-only, then redirect-only, observe it, remove active compute and
   secrets after explicit approval, and archive the repository.

Each stage is independently deployable and reversible. PR #118 remains the
foundation; it is hardened rather than replaced or expanded into a monolithic
all-capabilities change.

## Options Considered

| Option | Pros | Cons |
| --- | --- | --- |
| Extend PR #118 with the entire transition | One branch and one review | Couples schema, public APIs, agents, blobs, voice, migration, and retirement; difficult review and rollback |
| **Harden #118, then ship vertical slices** | Preserves tested work, validates risk early, additive and reversible | Temporary coexistence and several release gates |
| Supersede #118 with a fresh implementation | Cleanest history | Repeats working code and risks reintroducing fixed auth/MCP defects |

## Consequences

Compass gains a single research-to-decision provenance chain and Helio can be
retired without discarding its useful workflows. The cost is temporary dual
operation, additional token/provenance models, and explicit retention and
cutover duties. Production merge, migration, DNS, deletion, and retirement remain
separate approval gates even after implementation approval.

## Risks

- Participant prompt injection could disclose internal Compass data if broad
  tools are reintroduced.
- The sandboxed Agent SDK interviewer may have unacceptable participant latency;
  a real deployed turn is a release gate.
- Voice, guided UX, and Blob migration add browser, security, and retention edge
  cases.
- Helio projects have no user/workspace ownership, so any non-empty retained data
  needs an explicit mapping before import.
- DSQL optimistic concurrency requires retry-safe ordering and idempotency.

## Verification

- Cross-workspace denial for every study, token, session, turn, synthesis,
  attachment, and Evidence operation.
- Token expiry/revocation, research-credential expiry, prompt-injection, request
  limits, rate limits, idempotency, concurrency, resume, and abandonment tests.
- One real preview interview through participant route → Agent SDK → model → DSQL,
  with no Compass MCP attached, followed by researcher transcript review.
- Before applying migration 036, verify each token/sequence backfill source is
  below Aurora DSQL's 3,000-row and 10 MiB write-transaction limits; batch the
  data migration instead if either bound is exceeded. Do not enable Capture or
  run the concurrency smoke until every new ASYNC unique index reports ACTIVE.
- Real guided-UX, attachment, voice, synthesis, and Evidence-promotion journeys.
- Existing Feedback/Inbox, portal, voting, attachments, opportunity links,
  roadmap actions, and `/feedback` URLs remain unchanged.
- Helio export/import dry run, rerun safety, count/checksum reconciliation,
  legacy-link behavior, production smoke tests, and redirect-only observation.

## Revisit Triggers

- Real participant turns show that sandbox/agent latency is unacceptable.
- Study-scoped context cannot be made non-disclosive under adversarial testing.
- Findings need an independent lifecycle beyond synthesis and Evidence promotion.
- Final Helio inventory contains data or traffic inconsistent with the observed
  empty pre-cutover state.
