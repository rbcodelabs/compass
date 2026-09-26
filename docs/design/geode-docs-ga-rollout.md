# Design — GA Rollout Plan for Geode-Backed Document Storage

- **Status:** Proposed — companion to ADR 0018, routed for human decision, not self-certified
- **Date:** 2026-09-26
- **Decision of record:** [ADR 0018 — General Availability Rollout for Geode-Backed Document
  Storage](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/0ef4eae1-d559-4a2b-b339-08472b5f220b)
  (Compass Doc — architecture decisions for this repo live in Compass Docs, not `docs/decisions/`; see
  `docs/decisions/README.md`). Pending review at
  <https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/3ca68a17-0cfc-4a97-8161-7853f66a4c3a>.
- **Pilot this builds on:** `docs/decisions/0017-vercel-managed-docs-pilot.md` (ADR 0017), shipped via
  PR #276 (2026-09-25) and PR #281 (2026-09-24). One hardcoded workspace, env-var gated
  (`GEODE_DOCS_PILOT_WORKSPACE_ID`).
- **Scope:** phased plan for moving `Doc`/`DocVersion` storage from DB-text to
  `@rbcodelabs/geode-headless` across all workspaces, with explicit go/no-go criteria per phase.
- **Explicitly out of scope:** the parallel redesign of the agent tool interface for Docs
  ("doc-fs" — bespoke CRUD tools vs. a filesystem-shaped MCP surface). This plan does not require or
  assume that redesign, and it must not — `hydrateDocument()` already erases the storage-provider
  distinction at the read boundary, which is the seam that keeps the two decoupled. See ADR 0018 §6.

## Why a plan doc, not just the ADR

ADR 0018 makes the decision (rollout strategy, gating philosophy, risk acceptance). This doc is the
checklist an engineer or on-call operator actually runs against — phase by phase, with a literal
go/no-go gate before advancing. Keeping the checklist in the repo (versioned, diffable, PR-reviewable
alongside the code it gates) rather than only in the Compass ADR keeps it next to the migrations and
scripts it references.

## Phase 0 — Close the pilot's own unmet precondition

ADR 0017 required hosted verification (wrong-target rejection, ownership/collision, signed-run
expiry/replay/revocation, cross-workspace denial, a full round-trip against the real hosted deployment)
before the *pilot* was considered proven, not just locally tested. Repo history since PR #276/#281 shows
no follow-up commit addressing that checklist. This phase closes it — it is not optional groundwork, it
is the pilot's own unfinished exit criteria.

**Go/no-go to advance to Phase 1:**
- [ ] Every item in ADR 0017's "Required evidence" section has been executed against the real hosted
      deployment (not local Postgres) for the one pilot workspace, with results recorded.
- [ ] `scripts/verify-geode-documents.ts` and `scripts/verify-geode-document-migration.ts` have been run
      against a hosted preview deployment at least once, not only in CI against an isolated local DB.
- [ ] No open finding from that verification is unresolved.

## Phase 1 — Package provenance and IAM gates (prerequisite work, no new workspaces)

Both gates from ADR 0018 must close before any workspace beyond the existing pilot workspace is
switched. No rollout code work should start until this phase's checklist is checked off — it changes
what "safe" means for every later phase.

**Go/no-go to advance to Phase 2:**
- [ ] **Package provenance:** either (a) a second real version of `@rbcodelabs/geode-headless` has been
      published and successfully consumed by Compass (proving the upgrade path), with a changelog entry
      for it in `packages/headless`, or (b) an explicit, written compensating-control policy is accepted:
      permanent exact-pin (`"0.1.0"`-style, never `^`/`~`) plus a mandatory human-reviewed PR for every
      future bump that states what changed upstream and how it was verified.
- [ ] **IAM/credentials:** either (a) a scoped IAM role has been obtained for the Vercel-managed AWS
      integration (or a hybrid managed-compute/scoped-role arrangement) and DSQL access is now
      database-enforced per-workspace, not application-only, or (b) a distinct, named accepted-risk
      decision (not inherited from ADR 0017) has been signed off, with the compensating controls from
      ADR 0018 §2 (generalized fail-closed isolation checks on every storage code path, audit logging of
      cross-workspace-shaped access attempts, a written incident runbook) implemented and reviewed.
- [ ] Compass CI dependency scanning (`npm audit` / dependency-review) is confirmed to actually cover
      `@rbcodelabs/geode-headless` — verify it isn't silently excluded.

## Phase 2 — Rollout mechanism build-out (code, still zero non-pilot workspaces live)

Build the generalized versions of what the pilot hardcoded, without yet flipping any workspace beyond
the existing pilot one.

- [ ] Replace `isDocumentPilotWorkspace`'s single hardcoded `GEODE_DOCS_PILOT_WORKSPACE_ID` check with a
      cohort predicate (explicit workspace-ID list first; percentage-bucket hashing added before Phase 4c),
      preserving every existing fail-closed environment/schema check unchanged.
- [ ] Build the backfill worker (see "Backfill mechanism" below) and dry-run it against a copy of
      production-shaped data in a non-production schema. Confirm CAS-skip behavior on a row mutated
      mid-backfill (simulate a concurrent edit during the read-upload-flip window).
- [ ] Build the blob-orphan reconciliation sweep: list `doc_storage_objects` inventory rows with no
      corresponding live `contentRef` past a retention window, and delete. Dry-run in report-only mode
      first; confirm it reconciles from the inventory table, never from "document row is absent."
- [ ] Verify degrade-not-fail behavior: simulate the blob store being unreachable and confirm (a) reads
      of already-open non-GEODE-path content are unaffected, (b) GEODE-path reads surface a distinct
      "temporarily unavailable" state rather than a generic error boundary, and (c) a write-path failure
      surfaces "couldn't save, try again" to the user rather than silently no-op-ing or partially applying.

**Go/no-go to advance to Phase 3:**
- [ ] Cohort predicate code reviewed and merged; defaults to DB-backed for every unlisted workspace.
- [ ] Backfill worker dry-run completed with a recorded ledger of per-row hash-verified results and zero
      unexplained mismatches.
- [ ] Reconciliation sweep dry-run completed in report-only mode with sane output (no false positives
      against live data).
- [ ] Degrade-not-fail behavior observed working under simulated store-unavailability, not just reasoned
      about from the code.

## Phase 3 — Dogfooding cohort

- [ ] Add 1–3 internal/staff workspaces to the cohort list. Small blast radius, fast internal feedback.
- [ ] Run the backfill worker for real (not dry-run) against these workspaces' existing DB-text docs.
- [ ] Turn on the reconciliation sweep in delete mode for this cohort only.
- [ ] Soak for a defined period (recommend at least one full week of normal internal usage, including at
      least one edit-during-backfill collision if one occurs naturally, or a deliberately staged one if not).

**Go/no-go to advance to Phase 4a:**
- [ ] Zero data-integrity incidents (a byte-identical verification failure counts as one, even if caught
      and resolved).
- [ ] Zero orphaned-blob accumulation beyond what the reconciliation sweep is cleaning up as expected.
- [ ] No unplanned rollback of any dogfooding workspace back to DB-text.

## Phase 4 — Opt-in and percentage cohort ramp

- **4a — Explicit opt-in.** Workspaces (internal teams or customers) that ask in are added to the cohort
  list individually. No automatic triggers yet.
- **4b — Small percentage cohort.** Move to percentage-bucket hashing of workspace ID; ramp 1% → 10%.
  Review the bucketing function before this step — confirm it produces a representative sample, not a
  biased subset (e.g., not correlated with workspace creation order or size).
- **4c — Majority ramp.** 50% → 100%, each step soaked and reviewed before advancing.

**Go/no-go between every step in this phase (repeat, not a one-time check):**
- [ ] No open data-integrity or availability incident attributable to Geode storage from the previous step.
- [ ] Reconciliation sweep and backfill ledger both show expected, explainable state — no unexplained
      growth in orphaned blobs or unverified rows.
- [ ] IAM/credentials posture from Phase 1 has not regressed (e.g., no new code path added that bypasses
      the isolation checks).

Do **not** introduce usage/size-based auto-triggers (e.g., "auto-migrate workspaces over N documents") in
this initial rollout — ADR 0018 explicitly defers that to after percentage rollout completes without
incident, to avoid combining two axes of nondeterminism (which workspace moves, and when) while the
mechanism still has limited hosted track record.

## Backfill mechanism (reference, used by Phases 2–4)

For each `Doc` row with `storageProvider IS NULL`:

1. Read current `content`.
2. Upload via `getDocumentStore(workspaceId).putContent(content)`.
3. Conditional flip: `UPDATE docs SET storage_provider='GEODE', content_ref=$ref, revision=$new WHERE id=$id
   AND storage_provider IS NULL AND content = $contentReadInStep1`. A CAS miss means the row changed since
   it was read (an active edit) — skip it this pass; it is picked up again next batch with fresh content.
   This is the answer to "what if a doc is being edited during its own backfill": the in-flight edit wins,
   the backfill attempt is simply discarded, no torn write, no data loss.
4. After the CAS commits, re-read via `hydrateDocument` and compare a sha256 of the returned content
   against a sha256 taken in step 1. Record pass/fail in a backfill ledger (new table, or a
   `doc_operations`-shaped receipt). A mismatch here is a read-path bug, not a backfill bug — it does not
   roll back the already-committed flip, it pages for investigation.
5. `DocVersion` rows use the same mechanism independently; they are immutable once created, so there is no
   active-edit race to handle for them.
6. The worker is a bounded batch job (cron or manual trigger), idempotent per row (a re-run of an
   already-flipped row is a no-op because the CAS precondition no longer matches), consistent with
   `lib/migrations/runner.ts`'s existing idempotent-and-resumable convention for data migrations in this
   repo.
7. Rollback is forward-only per row by design (GEODE rows keep no automatic path back to DB-text). A
   wholesale abandonment of GEODE storage would be a separate reverse-backfill using the same
   CAS-and-verify shape in the other direction — not covered further here since it isn't part of this
   rollout plan's expected path.

## What this plan explicitly does not decide

- Whether the doc-fs / tool-interface redesign ships before, after, or alongside this rollout — orthogonal
  by construction (see "Explicitly out of scope" above).
- Whether a scoped IAM role is actually obtainable — that is investigation work for Phase 1, not assumed
  here either way.
- The specific percentage-bucket hash function for Phase 4b — to be reviewed as its own small design
  decision when Phase 4b is reached, not pre-committed now.
