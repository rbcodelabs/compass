# Design — Cutover Plan for Geode-Backed Document Storage

- **Status:** Proposed — companion to ADR 0018, routed for human decision, not self-certified
- **Date:** 2026-09-26 (revised same day — see "Revision note" below)
- **Decision of record:** [ADR 0018 — Direct Cutover to Geode-Backed Document
  Storage](https://compass.rbcodelabs.com/rbcodelabs/compass/docs/0ef4eae1-d559-4a2b-b339-08472b5f220b)
  (Compass Doc — architecture decisions for this repo live in Compass Docs, not `docs/decisions/`; see
  `docs/decisions/README.md`). A prior pending review
  (<https://compass.rbcodelabs.com/rbcodelabs/compass/reviews/3ca68a17-0cfc-4a97-8161-7853f66a4c3a>) was
  based on the pre-revision cohort/percentage-rollout draft and should be disregarded — see "Revision
  note" and the report accompanying this change for what happened to that request.
- **Pilot this builds on:** `docs/decisions/0017-vercel-managed-docs-pilot.md` (ADR 0017), shipped via
  PR #276 (2026-09-25) and PR #281 (2026-09-24). One hardcoded workspace, env-var gated
  (`GEODE_DOCS_PILOT_WORKSPACE_ID`).
- **Scope:** concrete checklist for cutting the product owner's real workspace(s) over from DB-text to
  `@rbcodelabs/geode-headless` storage, with explicit go/no-go criteria per step.
- **Explicitly out of scope:** the parallel redesign of the agent tool interface for Docs
  ("doc-fs" — bespoke CRUD tools vs. a filesystem-shaped MCP surface). This plan does not require or
  assume that redesign, and it must not — `hydrateDocument()` already erases the storage-provider
  distinction at the read boundary, which is the seam that keeps the two decoupled. See ADR 0018 §6.

## Revision note

This plan originally staged a multi-phase cohort/percentage rollout (dogfood workspaces → opt-in →
1%/10%/50%/100% cohort ramp). That shape protects other customers' data and uptime during a gradual
rollout. Compass is pre-release with exactly one real user — the product owner, who is also the author of
`@rbcodelabs/geode-headless` — so there is no multi-tenant blast radius to protect against today. This
revision replaces the cohort ramp with a direct cutover: verify the mechanism end-to-end against the
hosted deployment, migrate the owner's real data with full integrity verification, flip storage over,
watch closely for a short window. The data-integrity sections (backfill correctness, byte-identical
verification, rollback) are unchanged — those protect against a bad migration corrupting real content,
which matters at any user count.

The package-provenance framing also changed: the original plan treated `@rbcodelabs/geode-headless` as an
external dependency that needed to earn trust (a second release, changelog discipline, or a hard-pin
policy). It's the same person's second codebase — see ADR 0018 §1 for the revised approach (extend the
SDK directly when needed; keep version-bump discipline; drop the trust-building gate).

## Why a plan doc, not just the ADR

ADR 0018 makes the decision (cutover approach, gating philosophy, risk acceptance). This doc is the
checklist an engineer or on-call operator actually runs against — step by step, with a literal go/no-go
gate before advancing. Keeping the checklist in the repo (versioned, diffable, PR-reviewable alongside
the code it gates) rather than only in the Compass ADR keeps it next to the migrations and scripts it
references.

## Step 0 — Close the pilot's own unmet precondition

ADR 0017 required hosted verification (wrong-target rejection, revision-conflict handling, a full
create/read/restore round-trip against the real hosted deployment) before the *pilot* was considered
proven, not just locally tested. Repo history since PR #276/#281 shows no follow-up commit addressing
that checklist. This step closes it — it is not optional groundwork, it is the pilot's own unfinished
exit criteria, and it matters regardless of how many users exist.

Scope is deliberately narrower than the original draft: keep the checks that prove the *mechanism* works
against the real hosted deployment; drop anything from ADR 0017's original checklist that was specifically
about detecting cross-*tenant* access, since there is no second tenant to test against yet.

**Go/no-go to advance to Step 1:**
- [ ] Wrong-target rejection verified against the real hosted deployment (not local Postgres).
- [ ] Revision-conflict (optimistic concurrency) handling verified against the real hosted deployment.
- [ ] A full create → read → restore round-trip verified against the real hosted deployment.
- [ ] `scripts/verify-geode-documents.ts` and `scripts/verify-geode-document-migration.ts` have been run
      against a hosted preview deployment at least once, not only in CI against an isolated local DB.
- [ ] No open finding from that verification is unresolved.

## Step 1 — IAM posture and SDK versioning (prerequisite work, no data migrated yet)

- [ ] **IAM/credentials:** check whether the Vercel-managed AWS integration now supports scoped custom
      roles, or whether a hybrid (Vercel-managed compute, a scoped role bound at the DSQL cluster) is
      available. If yes, adopt it — this closes ADR 0017's accepted gap properly. If not, read
      `isDocumentPilotWorkspace()`'s fail-closed checks end-to-end and confirm every branch actually fails
      closed, then record a short explicit note accepting application-level-only isolation given the data
      at risk is the owner's own. No cross-tenant audit logging or incident runbook is required for this —
      that's ceremony for a customer base that doesn't exist.
- [ ] **SDK versioning discipline:** confirm `package.json` still exact-pins `@rbcodelabs/geode-headless`
      (no `^`/`~`). If a Compass need requires a Geode Headless SDK change, make that change directly in
      the `geode` repo and bump the version deliberately when it's picked up — no changelog-discipline
      requirement, no "second release" precondition.
- [ ] Compass CI dependency scanning (`npm audit` / dependency-review) is confirmed to actually cover
      `@rbcodelabs/geode-headless` — verify it isn't silently excluded. (This is ordinary hygiene, not
      supply-chain trust-building — worth keeping regardless of who owns the package.)

## Step 2 — Build the cutover mechanism (code, still zero real data migrated)

- [ ] Replace `isDocumentPilotWorkspace`'s single hardcoded `GEODE_DOCS_PILOT_WORKSPACE_ID` check with a
      short explicit allowlist of the product owner's real workspace(s) — not percentage-bucket hashing,
      not a cohort tier system. Preserve every existing fail-closed environment/schema check unchanged.
- [ ] Build the backfill worker (see "Backfill mechanism" below) and dry-run it against a copy of the
      owner's real data in a non-production schema. Confirm CAS-skip behavior on a row mutated mid-backfill
      (simulate a concurrent edit during the read-upload-flip window).
- [ ] Build the blob-orphan reconciliation sweep: list `doc_storage_objects` inventory rows with no
      corresponding live `contentRef` past a retention window, and delete. Dry-run in report-only mode
      first; confirm it reconciles from the inventory table, never from "document row is absent."
- [ ] Verify degrade-not-fail behavior: simulate the blob store being unreachable and confirm (a) reads
      of already-open non-GEODE-path content are unaffected, (b) GEODE-path reads surface a distinct
      "temporarily unavailable" state rather than a generic error boundary, and (c) a write-path failure
      surfaces "couldn't save, try again" to the user rather than silently no-op-ing or partially applying.
      This matters for the owner's own daily use, not multi-tenant SLA — do it before cutover regardless.

**Go/no-go to advance to Step 3:**
- [ ] Allowlist code reviewed and merged; defaults to DB-backed for every workspace not on the list.
- [ ] Backfill worker dry-run completed with a recorded ledger of per-row hash-verified results and zero
      unexplained mismatches.
- [ ] Reconciliation sweep dry-run completed in report-only mode with sane output (no false positives
      against live data).
- [ ] Degrade-not-fail behavior observed working under simulated store-unavailability, not just reasoned
      about from the code.

## Step 3 — Direct cutover

No dogfood tier, no opt-in tier, no percentage ramp — this is the entire cutover:

1. [ ] Confirm Steps 0–2 are fully checked off.
2. [ ] Run the backfill worker for real (not dry-run) against the owner's actual real workspace(s).
       Every row's byte-identical verification (sha256 comparison, per the backfill mechanism below) must
       pass before that row counts as migrated.
3. [ ] Add the owner's real workspace(s) to the allowlist from Step 2.
4. [ ] Watch closely for a short, defined window (days, not weeks) — normal daily use of Docs is the
       verification here, since the owner is both the only user and the person best positioned to notice
       anything wrong.
5. [ ] Keep the reverse-backfill rollback lever (see "Backfill mechanism," step 7) ready and rehearsed
       during the watch window — not just documented, actually confirmed runnable — in case something
       surfaces.

**Done when:**
- [ ] All real documents for the owner's workspace(s) show `storageProvider = 'GEODE'` with a verified
      byte-identical backfill record.
- [ ] The watch window has passed with no data-integrity or availability incident.
- [ ] The reconciliation sweep shows expected, explainable state (no unaccounted-for orphaned blobs).

## When a staged rollout mechanism becomes worth building

If Compass later takes on other real users or workspaces containing someone else's content, that is the
point to design a cohort/percentage rollout mechanism — not before. Revisit ADR 0018 at that time rather
than treating this cutover's simplicity as a permanent constraint.

## Backfill mechanism (reference, used by Steps 2–3)

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
   CAS-and-verify shape in the other direction. Rehearse this direction before Step 3's watch window, not
   just document it, since it's the actual lever if something goes wrong during cutover.

## What this plan explicitly does not decide

- Whether the doc-fs / tool-interface redesign ships before, after, or alongside this cutover — orthogonal
  by construction (see "Explicitly out of scope" above).
- Whether a scoped IAM role is actually obtainable — that is investigation work for Step 1, not assumed
  here either way.
- What a staged rollout mechanism should look like if Compass later needs one — deferred to that future
  decision rather than pre-designed now.
