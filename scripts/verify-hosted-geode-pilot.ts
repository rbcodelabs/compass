/**
 * One-time manual proof of ADR 0017's "Required evidence" hosted-deployment
 * half -- the part explicitly called out as never having been run
 * ("Local PostgreSQL is not DSQL proof"). Exercises the live PR276
 * vercel-managed pilot deployment via synthetic UI (the real Docs editor,
 * private Blob-backed) with two independent authenticated personas,
 * targeting only the existing synthetic pilot workspace.
 *
 * NOT part of any automated suite: this talks to real hosted infrastructure
 * (Vercel + Aurora DSQL + private Blob) for one specific, already-approved
 * pilot branch/deployment (docs/decisions/0017-vercel-managed-docs-pilot.md).
 * Run manually, once, with:
 *
 *   PR276_SIGNING_KEY_PATH=<path to the Ed25519 PEM private key> \
 *   COMPASS_VERCEL_BYPASS_SECRET=... \
 *   node --import tsx scripts/verify-hosted-geode-pilot.ts
 *
 * MCP-based verification was attempted first and abandoned: the only way to
 * mint the personal `cmp_` API key MCP requires is the Settings page's
 * "Generate" button, and that page 500s for *any* authenticated session on
 * this managed-mode deployment -- app/[orgSlug]/[workspaceSlug]/settings/
 * page.tsx builds `analyticsActor = { userId, purpose: "USER" }` with no
 * `scopeWorkspaceId`, which lib/mcp-authz.ts's managed-mode branch of
 * `assertActorWorkspaceScope` then rejects (it requires
 * `actor.scopeWorkspaceId === managed.workspaceId`). This is a real,
 * previously-unknown regression surfaced by this hosted run -- see the
 * accompanying report for detail. It blocks *minting a key*, not the
 * document mechanism itself, so this script instead drives the actual Docs
 * editor UI (the same interaction shape as
 * e2e/functional/specs/docs-geode-pilot.spec.ts, adapted for a live
 * deployment with two real signed-in personas instead of direct DB access).
 *
 * The deployment/run/workspace identifiers below were independently obtained
 * by cross-checking `gh api repos/rbcodelabs/compass/branches/...`, the
 * Vercel deployments API for PR276, and this deployment's own
 * `/api/admin/migrate` status response (which echoes back the durable
 * `run_id`/`workspace_id` recorded in the schema's `_managed_pilot_owner`
 * table at initialization) -- operational metadata, not a credential, so it
 * is safe to record here. PR276 (docs/decisions/0017-...) merged as PR #276
 * before this checklist was ever run against its hosted deployment; the
 * managed-auth driver's own freshness check requires the PR to still be
 * *open* (scripts/preview-automation/contracts.ts's validateDeployment), so
 * this script re-implements an equivalent freshness guard for a *merged*
 * PR276 instead of loosening that shared, still-open-PR-oriented check.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, request as playwrightRequest, expect, type Page } from "@playwright/test"
import { signGrant, originHeaders } from "./preview-automation/contracts"

const DEPLOYMENT_ID = "dpl_56j75aNxq3LqXwYN5UwkZFcqyscH"
const ORIGIN = "https://compass-5bcgelmtw-rbcodelabs-team.vercel.app"
const RUN_ID = "6b8d0913-04af-4a3d-8fd0-7039ea14877e"
const EXPECTED_SHA = "c9fe909f3a3bff5046f364d296aaf2b052f6a49a"
const EXPECTED_BRANCH = "feat/geode-docs-preview-pilot"
const VERCEL_TEAM_ID = "team_qjKFRvZrF6oR8L9yCtqi8AYU"
const VERCEL_PROJECT_ID = "prj_BofzJ65kFnTykvTkoti7o4hjvxw9"

function must(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Required env var missing: ${name}`)
  return value
}

function getVercelToken(): string {
  const authPath = join(homedir(), "Library/Application Support/com.vercel.cli/auth.json")
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as { token?: string }
  if (!auth.token) throw new Error("No Vercel CLI token found; run `vercel login`")
  return auth.token
}

function ghApi(path: string): unknown {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }))
}

/**
 * Equivalent of contracts.ts's validateDeployment, adapted for a PR that has
 * since merged. Confirms this is a genuine, immutable, first-party, READY,
 * non-production PR276 pilot deployment -- independently, not by trusting
 * the constants above at face value.
 */
async function verifyDeploymentIsGenuine(): Promise<void> {
  const token = getVercelToken()
  const res = await fetch(`https://api.vercel.com/v13/deployments/${DEPLOYMENT_ID}?teamId=${VERCEL_TEAM_ID}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Deployment lookup failed (${res.status})`)
  const d = (await res.json()) as { projectId: string; readyState: string; target: string | null; url: string; meta?: Record<string, string> }
  if (d.projectId !== VERCEL_PROJECT_ID || d.readyState !== "READY" || d.target === "production") throw new Error("Deployment is not a READY, non-production, correct-project build")
  if (`https://${d.url}` !== ORIGIN) throw new Error("Deployment URL does not match the expected origin")
  const meta = d.meta ?? {}
  if (meta.githubCommitSha !== EXPECTED_SHA || meta.githubCommitRef !== EXPECTED_BRANCH || `${meta.githubCommitOrg}/${meta.githubCommitRepo}` !== "rbcodelabs/compass")
    throw new Error("Deployment metadata does not match the reviewed PR276 pilot branch/commit")
  const pr = ghApi("repos/rbcodelabs/compass/pulls/276") as { state: string; merged: boolean; head: { ref: string; repo?: { full_name: string } }; base: { repo: { full_name: string } } }
  if (pr.state !== "closed" || !pr.merged || pr.head.ref !== EXPECTED_BRANCH || pr.base.repo.full_name !== "rbcodelabs/compass" || pr.head.repo?.full_name !== "rbcodelabs/compass")
    throw new Error("PR276 is not the expected merged first-party pilot PR")
  const commit = ghApi(`repos/rbcodelabs/compass/commits/${EXPECTED_SHA}`) as { sha: string }
  if (commit.sha !== EXPECTED_SHA) throw new Error("Commit is not reachable in rbcodelabs/compass")
  console.log("[genuine] Deployment independently verified: READY, non-production, matches merged PR276 head commit")
}

async function main() {
  await verifyDeploymentIsGenuine()

  const privateKey = readFileSync(must("PR276_SIGNING_KEY_PATH"), "utf8")
  const bypass = must("COMPASS_VERCEL_BYPASS_SECRET")
  const grantCtx = await playwrightRequest.newContext()

  async function grantCall(operation: "bootstrap" | "session" | "teardown", persona?: "owner" | "viewer") {
    const claims = operation === "session" ? { persona: persona! } : {}
    const token = signGrant({ deploymentId: DEPLOYMENT_ID, origin: ORIGIN, runId: RUN_ID, operation, ...claims }, privateKey)
    const resp = await grantCtx.post(`${ORIGIN}/api/preview-automation/${operation}`, {
      headers: { ...originHeaders(ORIGIN, ORIGIN, bypass), Authorization: `Bearer ${token}` },
      data: claims, maxRedirects: 0, timeout: 30_000,
    })
    if (!resp.ok()) throw new Error(`${operation} failed (${resp.status()}): ${await resp.text()}`)
    return JSON.parse(await resp.text()) as Record<string, unknown>
  }
  async function sessionStorageState(persona: "owner" | "viewer") {
    const ctx = await playwrightRequest.newContext()
    const token = signGrant({ deploymentId: DEPLOYMENT_ID, origin: ORIGIN, runId: RUN_ID, operation: "session", persona }, privateKey)
    const resp = await ctx.post(`${ORIGIN}/api/preview-automation/session`, {
      headers: { ...originHeaders(ORIGIN, ORIGIN, bypass), Authorization: `Bearer ${token}` },
      data: { persona }, maxRedirects: 0, timeout: 30_000,
    })
    if (!resp.ok()) throw new Error(`session(${persona}) failed (${resp.status()}): ${await resp.text()}`)
    const state = await ctx.storageState()
    await ctx.dispose()
    return state
  }

  const bootstrap = await grantCall("bootstrap")
  if (bootstrap.orgSlug !== `preview-${RUN_ID}` || bootstrap.workspaceSlug !== "workspace")
    throw new Error(`Unexpected bootstrap identity: ${JSON.stringify(bootstrap)}`)
  console.log(`[bootstrap] org=${bootstrap.orgSlug} workspace=${bootstrap.workspaceSlug} isolated=${bootstrap.isolatedWorkspaceSlug} (idempotent -- reuses the existing pilot run/workspace if already initialized)`)

  const ownerState = await sessionStorageState("owner")
  const viewerState = await sessionStorageState("viewer")
  console.log("[session] owner and viewer sessions issued (two independent signed-run grants)")

  const browser = await chromium.launch()
  const extraHTTPHeaders = { "x-vercel-protection-bypass": bypass }
  const ownerPage = await (await browser.newContext({ storageState: ownerState, extraHTTPHeaders })).newPage()
  const basePath = `${ORIGIN}/${bootstrap.orgSlug}/${bootstrap.workspaceSlug}`

  // ── Create (synthetic UI, empty pilot workspace's first-page flow) ──
  await ownerPage.goto(`${basePath}/docs`, { waitUntil: "networkidle" })
  await ownerPage.getByRole("button", { name: "Create your first page" }).click()
  await ownerPage.waitForURL(/\/docs\/[0-9a-f-]+$/, { timeout: 20_000 })
  const docId = ownerPage.url().split("/").pop()!
  const docUrl = `${basePath}/docs/${docId}`
  console.log(`[create] doc ${docId} created via the real Docs UI (private-Blob-backed storage: pilot workspace)`)

  const ownerEditor = ownerPage.locator(".ProseMirror")
  await expect(ownerEditor).toBeEmpty()
  const initial = `Hosted pilot verify -- initial content ${Date.now()}`
  await ownerEditor.fill(initial)
  await expect(ownerPage.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 })
  console.log("[save] initial content autosaved")

  // ── Read (reload = re-fetch through hydrateDocument/private Blob) ──
  await ownerPage.reload({ waitUntil: "networkidle" })
  await expect(ownerEditor).toContainText(initial)
  console.log("[read] content round-tripped through private Blob storage after reload")

  // ── Named snapshot, for the later restore step ──
  await ownerPage.getByTitle("Save named version").click()
  const label = ownerPage.getByPlaceholder("Label (optional)")
  await label.fill("Hosted verify baseline")
  await label.press("Enter")
  await expect(label).not.toBeVisible()
  console.log("[snapshot] named version 'Hosted verify baseline' saved")

  const afterSnapshot = `Changed after snapshot ${Date.now()}`
  await ownerEditor.fill(afterSnapshot)
  await expect(ownerPage.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 })

  // ── Stale/concurrent revision rejection: two independent signed-in
  // personas editing the same doc. The viewer loads the doc (capturing
  // `afterSnapshot` as its baseline revision), the owner advances the doc
  // again, then the viewer's own save must lose -- its own edit is retained
  // as a local draft, never silently overwriting the owner's newer commit. ──
  const viewerPage = await (await browser.newContext({ storageState: viewerState, extraHTTPHeaders })).newPage()
  await viewerPage.goto(docUrl, { waitUntil: "networkidle" })
  const viewerEditor = viewerPage.locator(".ProseMirror")
  await expect(viewerEditor).toContainText(afterSnapshot)

  const ownerAdvanced = `Owner's second change, before viewer saves ${Date.now()}`
  await ownerEditor.fill(ownerAdvanced)
  await expect(ownerPage.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 })
  console.log("[concurrent] owner advanced the doc again while the viewer's tab was still on the older revision")

  const viewerConflictDraft = "Viewer's conflicting edit -- must never silently overwrite the owner's save"
  await viewerEditor.fill(viewerConflictDraft)
  await expect(viewerPage.getByRole("alert").filter({ hasText: "copy your draft before reloading" })).toBeVisible({ timeout: 15_000 })
  await expect(viewerEditor).toContainText(viewerConflictDraft)
  console.log("[conflict] stale revision correctly rejected -- viewer's UI shows the conflict alert, draft retained locally")

  // ── Preserved history and failed-write state: the owner's committed
  // content must be completely unaffected by the viewer's rejected write. ──
  await ownerPage.reload({ waitUntil: "networkidle" })
  await expect(ownerEditor).toContainText(ownerAdvanced)
  console.log("[preserved] owner's content is intact after the viewer's write was rejected -- no corruption, no silent overwrite")

  // ── Restore ──
  await ownerPage.getByTitle("Version history").click()
  await ownerPage.locator('[data-testid="doc-version-list"] button').filter({ hasText: "Hosted verify baseline" }).click()
  ownerPage.once("dialog", dialog => dialog.accept())
  await ownerPage.getByRole("button", { name: "Restore this version" }).click()
  await expect(ownerEditor).toContainText(initial)
  await expect(ownerPage.getByRole("heading", { name: "Version History" })).not.toBeVisible()
  console.log("[restore] named version restored; content reverted to the original snapshot")

  // ── Draft retention + retry-send on a request that never reaches the
  // server (the same technique as e2e/functional/specs/docs-geode-pilot.spec.ts).
  // This demonstrates the client never silently drops or duplicates a save;
  // exact same-operationId server-side replay is already proven locally
  // (Half 1, scripts/verify-geode-documents.ts) -- MCP would be the direct
  // way to also prove it against this hosted deployment, but MCP access is
  // blocked by the Settings-page regression documented above. ──
  let dropped = false
  await ownerPage.route(`**/docs/${docId}`, async route => {
    if (!dropped && route.request().method() === "POST" && route.request().headers()["next-action"]) { dropped = true; await route.abort("connectionfailed") }
    else await route.continue()
  })
  const retained = `Retained draft after a dropped save ${Date.now()}`
  await ownerEditor.fill(retained)
  await expect(ownerPage.getByRole("alert").filter({ hasText: "Your draft is still here" })).toBeVisible({ timeout: 15_000 })
  await expect(ownerEditor).toContainText(retained)
  await ownerPage.getByRole("button", { name: "Retry save" }).click()
  await expect(ownerPage.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 })
  await ownerPage.unroute(`**/docs/${docId}`)
  console.log("[retry] dropped-request draft retained and successfully resent")

  // ── Fresh-context read: an entirely new signed grant, new session cookie,
  // and new browser context/page -- no shared in-memory state whatsoever. ──
  const freshState = await sessionStorageState("owner")
  const freshPage = await (await browser.newContext({ storageState: freshState, extraHTTPHeaders })).newPage()
  await freshPage.goto(docUrl, { waitUntil: "networkidle" })
  await expect(freshPage.locator(".ProseMirror")).toContainText(retained)
  console.log("[fresh-context] a brand-new authenticated context read back the exact persisted content")

  async function verifyDocPage(page: Page) { return page.close() }
  await verifyDocPage(freshPage)
  await browser.close()
  await grantCtx.dispose()
  console.log(JSON.stringify({ proof: "hosted-geode-pilot-ui", docId, deploymentId: DEPLOYMENT_ID, sha: EXPECTED_SHA, passed: true }))
}

main().catch(error => { console.error(error); process.exitCode = 1 })
