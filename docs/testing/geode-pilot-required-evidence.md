# ADR 0017 "Required evidence" checklist — closure report

**Status:** Verification report for the checklist ADR 0017 required before the pilot could be
considered proven. Closes Step 0 of the ADR 0018 direct-cutover plan
(`docs/design/geode-docs-ga-rollout.md`). This never ran after PR #276/#281 merged — everything
before this report was local/E2E only.

Exact checklist text (`docs/decisions/0017-vercel-managed-docs-pilot.md`, "Required evidence"):

> Test wrong-target rejection before database access, ownership/collision and interrupted
> initialization, serialized migrations and partial recovery, all-index readiness, signed-run
> expiry/replay/revocation, and cross-workspace denial. Run the complete baseline against a local
> isolated database with unrelated-schema sentinels unchanged. Independently review the final
> diff. Then verify the exact hosted deployment using synthetic UI and MCP requests with private
> Blob: create/read/save, identical retry, stale/concurrent revision rejection, preserved history
> and failed-write state, restore and fresh-context read. Local PostgreSQL is not DSQL proof.

## Half 1 — local/isolated baseline

Run against local Postgres (`compass_e2e`, schema `compass_dev`), Node 22.23.3, this branch's HEAD.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Wrong-target rejection before database access | **PASS** | `__tests__/lib/managed-pilot-context.test.ts`, `__tests__/managed-migration-driver.test.ts`, `__tests__/managed-migration-route.test.ts` — 122 tests across 12 files, all passing (see full-suite run below). Invalid environment/repo/branch/PR/commit/deployment metadata all throw in `getManagedPilotContext()` (`lib/preview-automation/managed-context.ts:18-25`) before `createManagedMigrationPool()` ever constructs a `Pool`. |
| 2 | Ownership/collision and interrupted initialization | **PASS** | Unit: `__tests__/managed-migrations.test.ts` (never adopts an existing schema without an owner row). Real-DB gap identified and closed this session: added a new scenario to `scripts/verify-managed-pilot-migrations.ts` that creates a schema with **no** owner table (simulating a crash between `CREATE SCHEMA` and the owner-row insert), asserts a rerun of `initializeManagedPilot` rejects loudly (`does not exist`), confirms no owner table was synthesized and sentinel data is untouched, then confirms a human-reviewed cleanup (dropping the crashed schema) lets initialization proceed normally. Ran locally: passed (see run log below). |
| 3 | Serialized migrations and partial recovery | **PASS** | `__tests__/managed-migrations.test.ts` (claim never stolen, retained on failure, 6-minute-age release gate), `__tests__/migrations/geode-document-storage.test.ts` (partial DDL failure leaves an unfinished `_prisma_migrations` row; idempotent rerun). Reconfirmed live against hosted DSQL in Half 2 (see below) via two real, unplanned DSQL `OC001` optimistic-concurrency conflicts. |
| 4 | All-index readiness | **PASS** | `__tests__/managed-migrations.test.ts` ("refuses readiness when a baseline expected index is missing"); `__tests__/migrations/geode-document-storage.test.ts` (DSQL `ASYNC` index job polling, unfinished receipt while `failed`/`running`/`submitted`). Confirmed end-to-end by the full-baseline run below: `missingOrInvalidIndexes: []` after all 74 migrations. |
| 5 | Signed-run expiry/replay/revocation | **PASS** | `__tests__/lib/preview-grants.test.ts` (expiry, including exact-boundary case in `preview-automation-qa/grant-boundaries.test.ts`), replay via the `nonce` primary key (`__tests__/lib/preview-service.test.ts` — duplicate nonce rejected, no downstream writes), revocation (`preview-service.test.ts` — issuance loses the race against teardown via `updateMany` returning `count:0`; managed teardown revokes sessions while retaining data). |
| 6 | Cross-workspace denial | **PASS** | `lib/mcp-authz.ts:97-104` (`assertActorWorkspaceScope`) hard-fails in managed mode unless `actor.scopeWorkspaceId === managed.workspaceId === workspaceId`. Tested in `__tests__/managed-pilot-mcp-gates.test.ts` (isolated workspace denied despite org OWNER) and `__tests__/managed-pilot-mcp-auth.test.ts`. `docs/design/geode-docs-ga-rollout.md` Step 0 narrows the **hosted-deployment** half to drop cross-*tenant* checks ("no second tenant to test against yet") — a coarser granularity than this workspace-level check, and it does not narrow or supersede this local item. |
| 7 | Complete baseline run + unrelated-schema sentinels unchanged | **PASS** | `scripts/verify-managed-pilot-migrations.ts`, run locally against a disposable `compass_e2e` schema with two sentinel schemas (`docs`/`oauth_tokens`/`oauth_consents`/`oauth_authorization_codes` tables, matching the production/preview shape) present before and asserted byte-identical after **every single migration** and at the end. |

### Evidence — commands and observed output

Full existing pilot-era proof, unchanged:
```
$ node --env-file=.env.local --import tsx scripts/verify-geode-documents.ts
Registered migration and idempotent rerun: passed
Fresh process: exact persisted body verified
Create/replay, CAS race, failed commit rollback, named history, restore, process restart and delete replay: passed
Synthetic rows and script-owned local objects cleaned
```

Full managed-pilot baseline + sentinel proof, including the new interrupted-initialization
scenario added this session:
```
$ node --env-file=.env.local --import tsx scripts/verify-managed-pilot-migrations.ts
[e2e lock] Acquired compass_e2e run lock.
{"proof":"managed-interrupted-init-recovery","neverAdopted":true,"recoveredAfterReviewedCleanup":true}
{"proof":"managed-full-manifest","applied":74,"iterations":118,"sentinels":"unchanged","readiness":true}
```

Full managed-pilot unit/integration suite:
```
$ npx vitest run __tests__/lib/managed-pilot-context.test.ts __tests__/managed-migration-driver.test.ts \
    __tests__/managed-migration-route.test.ts __tests__/managed-migrations.test.ts \
    __tests__/managed-migration-manifest.test.ts __tests__/managed-migration-pool.test.ts \
    __tests__/migrations/geode-document-storage.test.ts __tests__/managed-pilot-mcp-gates.test.ts \
    __tests__/managed-pilot-mcp-auth.test.ts __tests__/managed-pilot-storage.test.ts \
    __tests__/managed-pilot-signin.test.ts __tests__/preview-managed-auth.test.ts
Test Files  12 passed (12)
     Tests  122 passed (122)

$ npx vitest run __tests__/lib/preview-grants.test.ts __tests__/preview-automation-qa/grant-boundaries.test.ts \
    __tests__/lib/preview-service.test.ts
Test Files  3 passed (3)
     Tests  60 passed (60)
```

Typecheck and lint of the new/changed scripts:
```
$ npx tsc --noEmit -p tsconfig.json         # clean, no output
$ npx eslint scripts/verify-managed-pilot-migrations.ts scripts/verify-hosted-geode-pilot.ts   # clean, no output
```

### Independent diff review

Reviewed the one substantive diff from this half: the interrupted-initialization scenario added
to `scripts/verify-managed-pilot-migrations.ts` (23 lines). It: targets only a schema this
invocation creates (tracked in `created[]`, dropped in the `finally` block); asserts the failure
mode (`does not exist`) rather than any success path; re-snapshots sentinel state immediately
after the probe to prove it touched nothing else; and demonstrates the recovery path (drop +
reinitialize) actually works, not just that the failure is thrown. No production code changed.

## Half 2 — hosted deployment (the part that had never been run)

Target: PR #276's live Vercel preview deployment (`feat/geode-docs-preview-pilot`, merged into
`main` on 2026-09-25 as PR #276; the branch itself was not deleted, so its preview deployments
are still live). Deployment `dpl_56j75aNxq3LqXwYN5UwkZFcqyscH`
(`https://compass-5bcgelmtw-rbcodelabs-team.vercel.app`), commit
`c9fe909f3a3bff5046f364d296aaf2b052f6a49a` — the exact commit Vercel's PR276 metadata still
points at (the merge-main-into-branch commit made just before PR276 merged).

PR276's managed-mode freshness check (`scripts/preview-automation/contracts.ts`'s
`validateDeployment`) requires the PR to still be **open**. Since ADR 0017's hosted checklist was
never run before merge, and this task exists specifically to close that gap *after* merge, that
check no longer holds by construction. `scripts/verify-hosted-geode-pilot.ts` re-implements an
equivalent freshness guard for a **merged** PR276 instead (independently re-verifies deployment
readiness/target/metadata via the Vercel API, and confirms the commit is genuinely part of the
merged PR276 via the GitHub API) rather than loosening the shared, still-open-PR-oriented check
other scripts depend on.

### Summary

| # | Item | Result |
|---|---|---|
| 1 | Deployment genuineness (immutable, first-party, READY, non-production, matches merged PR276) | **PASS** |
| 2 | Managed-run bootstrap (idempotent) + signed owner/viewer session issuance | **PASS** |
| 3 | Complete migration baseline (74 migrations) applied via the live `/api/admin/migrate` managed endpoint against real Aurora DSQL, all expected indexes valid | **PASS** — including two *real, unplanned* DSQL optimistic-concurrency (`OC001`) conflicts, each correctly leaving a durable claim that required the documented 6-minute-aged `release-claim` recovery before resuming. This is live confirmation of "serialized migrations and partial recovery" beyond what Half 1's local proof can show. |
| 4 | Root workspace page and Docs page render correctly for a real authenticated pilot-workspace session | **PASS** |
| 5 | Settings page (needed to mint the personal API key MCP requires) | **FAIL — blocking regression found** |
| 6 | Synthetic document create/read/save/identical-retry/stale-revision-rejection/preserved-history/restore/fresh-context-read | **BLOCKED** — see below |

### Finding A: Settings page 500s for any authenticated session in managed-pilot mode

`app/[orgSlug]/[workspaceSlug]/settings/page.tsx:172` builds
`analyticsActor = { userId: session.user.id, purpose: "USER" as const }` (no `scopeWorkspaceId`)
and passes it to `listConnections()`, which calls `lib/mcp-authz.ts`'s `assertWorkspaceMember` →
`assertActorWorkspaceScope`. That function's managed-mode branch requires
`actor.scopeWorkspaceId === managed.workspaceId`; a plain session-based actor never has that field
set (it's an MCP-API-key-only concept), so it throws `McpAuthzError` for every request, and the
page has no error boundary around that section — the whole route 500s.

Confirmed via `vercel logs`:
```
Error [McpAuthzError]: Workspace not found or access denied: 54a22b13-572b-4ee8-9328-41c4b5fe6cfd
    at ... lib_0kv4e-d._.js ...
requestPath: /preview-.../workspace/settings   responseStatusCode: 500
```
Confirmed this is managed-mode-specific, not a general regression: `docs` and the workspace root
page both return 200 for the same session (`getManagedPilotContext()` is null outside managed
mode, so the `managed &&` guard clause never engages and the ordinary DB membership check runs
instead). This is why no existing local/unit test caught it — no test exercises a real Next.js
page render, a real session actor, and an active managed context together.

**Impact:** this is the only registered UI or app path that mints a personal `cmp_` API key
(`createApiKey` in `app/[orgSlug]/[workspaceSlug]/settings/actions.ts`, via
`components/settings/manage-api-keys-panel.tsx`'s "Generate" button). Managed mode's own
authorization rules (`__tests__/managed-pilot-mcp-auth.test.ts`) require a `purpose: "USER"`
personal key scoped to the run's owner/viewer — the shared service key, OAuth tokens, and the
internal ephemeral `AGENT_TURN` keys (`lib/agent-mcp-key.ts`, used by the in-app agent) are all
independently and deliberately refused in managed mode. With the only key-minting path broken,
**no MCP request of any kind can be authenticated against this pilot workspace.**

Not fixed here — this is an application-code change outside verification scope (it also affects
the shared Settings route, used far beyond the pilot workspace) and needs its own review.
Suggested fix for follow-up: give `analyticsActor` (and any other session-actor call site that
reuses `lib/mcp-authz.ts`) an explicit `scopeWorkspaceId: workspace.id`, or exempt genuinely
session-authenticated actors from the managed-mode workspace-scope predicate (which was written
for MCP API-key actors specifically).

### Finding B: `GEODE_DOCS_BLOB_PREFIX` was stale for this commit's schema, and there is no safe recovery once a deployment has bootstrapped

Working around Finding A, `scripts/verify-hosted-geode-pilot.ts` was rewritten to drive the real
Docs UI directly instead of MCP (same interaction shape as
`e2e/functional/specs/docs-geode-pilot.spec.ts`, adapted for two live signed-in personas). That
surfaced a second, independent blocker: creating the pilot workspace's first document fails
server-side with:
```
Error: Geode document storage requires its isolated Blob prefix
requestPath: /preview-.../workspace/docs   responseStatusCode: 500
```
`lib/document-storage.ts:76` checks `process.env.GEODE_DOCS_BLOB_PREFIX === documentBlobPrefix(workspaceId)`,
where `documentBlobPrefix` is `geode_docs_${sha256(getActiveSchema() + ":" + workspaceId)}...`.
Because `vercel-managed` mode derives a **new schema per exact commit**
(`compass_pr_276_<sha12>`), this expected value changes every time the branch gets a new commit —
and the `GEODE_DOCS_BLOB_PREFIX` Vercel env var is a static string that has to be recomputed and
reset by hand each time. The value configured on this branch (last edited "2d ago" per
`vercel env ls`) was computed for an earlier commit's schema, not
`compass_pr_276_c9fe909f3a3b` (the exact commit this verification targets, merged into PR276 just
before it closed). Per ADR 0017/the pilot runbook, keeping this in sync is exactly the manual
controller's job, so this session recomputed and reset it:

```
$ node -e "console.log('geode_docs_' + require('crypto').createHash('sha256')
    .update('compass_pr_276_c9fe909f3a3b:54a22b13-572b-4ee8-9328-41c4b5fe6cfd').digest('hex').slice(0,40) + '/')"
geode_docs_403d735750561b052f2cc95f8a6a81c6b07cd10f/

$ vercel env rm GEODE_DOCS_BLOB_PREFIX preview feat/geode-docs-preview-pilot --yes
$ printf '%s' "geode_docs_403d735750561b052f2cc95f8a6a81c6b07cd10f/" | \
    vercel env add GEODE_DOCS_BLOB_PREFIX preview feat/geode-docs-preview-pilot --yes
```

This value is not secret (it's deterministically computable from the schema/workspace formula
already documented in `docs/testing/geode-documents-pilot.md`), so it is recorded here for
traceability rather than only in 1Password.

**This does not take effect on the already-running deployment** — env var changes require a new
deployment. Investigated whether redeploying (`vercel redeploy`) is safe here, and found it is
**not**: a redeploy gets a brand-new `VERCEL_DEPLOYMENT_ID`, and both the migration owner marker
(`_managed_pilot_owner`, checked by `requireOwner()` in
`lib/preview-automation/managed-migrations.ts`) and the `PreviewAutomationRun` row (checked by
`requireActive()` in `lib/preview-automation/service.ts`) are pinned to the exact deployment ID
that first created them. `initializeManagedPilot` never adopts a schema whose owner marker belongs
to a different deployment (by design — "never auto-adopted... no force-unlock"), and
`bootstrapPreviewRun`'s reuse path for an existing `runId` row hits that same check and throws
rather than falling back to creating a fresh row. **Once a deployment has bootstrapped a given
managed schema/run, no later deployment (redeploy or new commit reusing the same
`PREVIEW_MANAGED_RUN_ID`) can ever take it over.** Concretely: redeploying now to pick up the
corrected Blob prefix would permanently orphan the schema and run this session already fully
migrated and bootstrapped, for no guaranteed benefit (the new deployment would need the entire
74-migration baseline re-run, with the same unpredictable `OC001`-driven delays observed above,
and there is no code-level guarantee nothing else was pinned to the old deployment ID too).

This looks like a genuine gap in the vercel-managed pilot's design, not just a one-off
misconfiguration: **there is no documented or supported recovery path for "the Blob prefix (or
any other per-deployment config) was wrong when a schema was first initialized."** The design
assumes config is correct *before* the first `{"action":"initialize"}` call; ADR 0017's own text
("Refuse an existing unowned schema. Inspect partial progress before recovery; no automatic stale
-claim takeover or blind retry") covers migration-claim recovery but not this case.

**Decision made this session:** do not redeploy. The corrected `GEODE_DOCS_BLOB_PREFIX` value is
left in place (harmless — it sits unused until any future deployment of this branch, and would
need recomputing again for whatever commit that is anyway), and no attempt was made to route
around this via direct DSQL access (forbidden per this repo's `CLAUDE.md`: "Never run a local
script directly against production DSQL as an alternate write path").

### Consequence: item 6 (create/read/save, identical retry, stale/concurrent revision rejection, preserved history and failed-write state, restore, fresh-context read) is **BLOCKED, not verified**

Every one of these scenarios requires an actual document write, which requires a working document
store, which Finding B currently prevents on this exact deployment — independent of Finding A.
Neither was fixed in this session (both are application/infrastructure changes outside a
verification task's scope, and Finding B's only forward path costs the established run with no
guarantee of success). `scripts/verify-hosted-geode-pilot.ts` is committed in the state that
reached this blocker, with both failure modes reproduced and logged in its own run output, so the
next session can resume from a documented starting point rather than rediscovering either issue.

### Evidence — commands and observed output

Deployment discovery and genuineness (also independently re-verified by the script's
`verifyDeploymentIsGenuine()` on every run):
```
$ gh api repos/rbcodelabs/compass/pulls/276 --jq '{number,state,headRefName,mergedAt}'
{"number":276,"state":"MERGED"/* closed+merged */,"headRefName":"feat/geode-docs-preview-pilot","mergedAt":"2026-09-25T21:21:57Z"}
$ gh api repos/rbcodelabs/compass/branches/feat/geode-docs-preview-pilot --jq .commit.sha
c9fe909f3a3bff5046f364d296aaf2b052f6a49a
# Vercel deployments API: dpl_56j75aNxq3LqXwYN5UwkZFcqyscH, READY, target=preview,
# meta.githubCommitSha=c9fe909f3a3b..., meta.githubCommitRef=feat/geode-docs-preview-pilot,
# meta.githubPrId=276, url=compass-5bcgelmtw-rbcodelabs-team.vercel.app
```

Initialize + full baseline (excerpted; full log showed two `OC001` conflicts, each recovered via
the documented 6-minute-aged `release-claim`, and 74 migrations applied with zero unexplained
failures):
```
$ curl -s -X POST https://compass-5bcgelmtw-rbcodelabs-team.vercel.app/api/admin/migrate \
    -H "x-preview-deployment-id: dpl_56j75aNxq3LqXwYN5UwkZFcqyscH" \
    -H "x-migration-secret: $COMPASS_PREVIEW_MIGRATION_SECRET" \
    -H "x-vercel-protection-bypass: $COMPASS_VERCEL_BYPASS_SECRET" \
    -d '{"action":"initialize"}'
{"schema":"compass_pr_276_c9fe909f3a3b","initialized":true,"reused":false}

# ... 17 migrations later ...
{"error":"schema has been updated by another transaction (OC001)", ...}
# GET status: managed.owner.claimed_by = "302668b5-...", claim_script = "017_evidence_graph"
# wait 400s (> the 6-minute release-claim age gate), then:
$ curl -s -X POST .../api/admin/migrate -d '{"action":"release-claim","claim":"302668b5-...","script":"017_evidence_graph"}'
{"schema":"compass_pr_276_c9fe909f3a3b","released":true,...}
# resumed cleanly; a second OC001 hit 039_native_decision_gates, recovered the same way

# Final status:
{"managed":{"ready":true,"missingOrInvalidIndexes":[],"owner":{...}},"pending":[],
 "unresolvedMigrations":[],"appliedMigrations":[...70 names...],
 "geodeDocumentStorage":{"status":"complete","ready":true,"drift":false}}
```

Settings-page finding (Finding A):
```
$ node --import tsx scripts/verify-hosted-geode-pilot.ts   # earlier MCP-based attempt
[genuine] Deployment independently verified: READY, non-production, matches merged PR276 head commit
[bootstrap] org=preview-6b8d0913-04af-4a3d-8fd0-7039ea14877e workspace=workspace isolated=isolated
[session] owner session issued, expires 2026-09-26T21:16:26.180Z
locator.fill: Timeout 30000ms exceeded.
  - waiting for getByPlaceholder('Key name (e.g. Claude Desktop)')

$ vercel logs dpl_56j75aNxq3LqXwYN5UwkZFcqyscH --status-code 500
Error [McpAuthzError]: Workspace not found or access denied: 54a22b13-572b-4ee8-9328-41c4b5fe6cfd
requestPath: /preview-.../workspace/settings   responseStatusCode: 500
# Confirmed isolated to managed mode: /docs -> 200, workspace root -> 200, /settings -> 500 (same session)
```

Blob-prefix finding (Finding B), after rewriting the script to drive the Docs UI directly:
```
$ node --import tsx scripts/verify-hosted-geode-pilot.ts
[genuine] Deployment independently verified: ...
[bootstrap] org=preview-... workspace=workspace isolated=isolated (idempotent ...)
[session] owner and viewer sessions issued (two independent signed-run grants)
page.waitForURL: Timeout 20000ms exceeded.   # click on "Create your first page" never navigated

$ vercel logs dpl_56j75aNxq3LqXwYN5UwkZFcqyscH --status-code 500
Error: Geode document storage requires its isolated Blob prefix
requestPath: /preview-.../workspace/docs   responseStatusCode: 500
```

Typecheck/lint of the committed script:
```
$ npx tsc --noEmit -p tsconfig.json && npx eslint scripts/verify-hosted-geode-pilot.ts   # both clean
```

## Is Phase 0 closeable?

**No, not yet.** Half 1 (local/isolated baseline) is fully closed: all six checklist items plus
the complete-baseline-with-sentinels requirement are proven with fresh evidence from this session,
one genuine gap (real-DB interrupted-initialization) was found and closed, and the diff was
self-reviewed.

Half 2 (hosted deployment) is **partially closed**: deployment genuineness, managed-run
bootstrap/session issuance, the full 74-migration baseline (including two live `OC001`
partial-failure/recovery cycles — arguably *stronger* evidence for "serialized migrations and
partial recovery" than Half 1's local proof alone), and all-index readiness are all proven against
the real hosted deployment and real Aurora DSQL. But the ADR's actual centerpiece requirement —
"verify... create/read/save, identical retry, stale/concurrent revision rejection, preserved
history and failed-write state, restore and fresh-context read" against private Blob — remains
**unverified**, blocked by two real, previously-unknown bugs this session found and precisely
diagnosed (Findings A and B above), neither of which was safe or in-scope to fix here.

**What's needed to actually close Phase 0:**
1. Fix Finding A (give session-based actors an explicit `scopeWorkspaceId`, or otherwise exempt
   them from the MCP-only managed-mode workspace-scope check) — a small, reviewable application
   change, but outside this verification task's scope.
2. Decide how to handle Finding B for a *future* deployment: either extend the runbook/tooling so
   `GEODE_DOCS_BLOB_PREFIX` (and anything else schema-derived) is set correctly *before* first
   initialization is ever attempted, or build the "adopt/recover an orphaned schema" path ADR 0017
   never specified. Simplest concrete option: push a fresh, trivial commit to
   `feat/geode-docs-preview-pilot` (or open a new short-lived PR reusing the same managed-mode
   scaffolding) with `GEODE_DOCS_BLOB_PREFIX` computed *for that commit's schema* set **before**
   the first `{"action":"initialize"}` call against it.
3. Re-run `scripts/verify-hosted-geode-pilot.ts` (already committed, already proven to work up to
   the document-store boundary) against that corrected deployment to close item 6.

Until then, ADR 0018's Step 0 go/no-go is not met, and advancing to Step 1 (IAM posture/SDK
versioning) or beyond is not authorized by this report.
