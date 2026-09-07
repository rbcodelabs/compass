import { chromium } from "@playwright/test"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { originHeaders, signGrant, type GrantInput } from "./contracts"
import { required, resolveTarget } from "./resolve"
import { verifyLease } from "./lease"

async function main() {
  const target = await resolveTarget()
  verifyLease(required("PREVIEW_PROVISION_RECEIPT"), required("PREVIEW_AUTOMATION_PUBLIC_KEY"), target)
  const runId = randomUUID(), dir = await mkdtemp(join(tmpdir(), "compass-preview-"))
  const bypass = required("PREVIEW_PROTECTION_BYPASS"), key = required("PREVIEW_AUTOMATION_PRIVATE_KEY")
  const exploring = process.argv.includes("--explore")
  const browser = await chromium.launch({ headless: !exploring && !process.argv.includes("--headed") })
  const context = await browser.newContext()
  const base = { deploymentId: target.deploymentId, origin: target.origin, runId }
  async function operation(operation: GrantInput["operation"], persona?: GrantInput["persona"]) {
    const now = Math.floor(Date.now() / 1000)
    const expiresNoLaterThan = operation === "bootstrap"
      ? Math.floor(verifyLease(required("PREVIEW_PROVISION_RECEIPT"), required("PREVIEW_AUTOMATION_PUBLIC_KEY"), target).expiresAt / 1000) - 3600
      : now + 300
    const response = await context.request.post(`${target.origin}/api/preview-automation/${operation}`, {
      headers: { ...originHeaders(target.origin, target.origin, bypass), Authorization: `Bearer ${signGrant({ ...base, operation, ...(persona ? { persona } : {}) }, key, now, expiresNoLaterThan)}` },
      data: persona ? { persona } : {}, maxRedirects: 0, timeout: 30_000,
    })
    if (!response.ok()) throw new Error(`Preview ${operation} failed (${response.status()})`)
    return response.json()
  }
  let bootstrapped = false, passed = false, cleaned = false
  try {
    // Mark before request: a lost response may still have created the run.
    bootstrapped = true
    const fixture = await operation("bootstrap")
    await operation("session", "owner")
    if (exploring) {
      await context.route("**/*", async route => {
        if (new URL(route.request().url()).origin !== target.origin) return route.abort()
        const response = await route.fetch({ headers: { ...route.request().headers(), ...originHeaders(target.origin, route.request().url(), bypass) }, maxRedirects: 0 })
        await route.fulfill({ response })
      })
      const page = await context.newPage()
      await page.goto(`${target.origin}/${fixture.orgSlug}/${fixture.workspaceSlug}`)
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); process.removeListener("SIGINT", finish); process.removeListener("SIGTERM", finish); resolve() }
        const timer = setTimeout(finish, Math.max(0, Math.min(3600_000, new Date(fixture.expiresAt).getTime() - Date.now())))
        page.once("close", finish); browser.once("disconnected", finish)
        process.once("SIGINT", finish); process.once("SIGTERM", finish)
      })
      passed = true
      return
    }
    const state = join(dir, "owner.json")
    await writeFile(state, JSON.stringify(await context.storageState()), { mode: 0o600 })
    await context.clearCookies()
    await operation("session", "viewer")
    const viewer = join(dir, "viewer.json")
    await writeFile(viewer, JSON.stringify(await context.storageState()), { mode: 0o600 })
    // Child receives only browser inputs, never signing key, GitHub/Vercel API or AWS credentials.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, CI: process.env.CI, PREVIEW_ORIGIN: target.origin, PREVIEW_OWNER_STATE: state, PREVIEW_VIEWER_STATE: viewer, PREVIEW_FIXTURE: JSON.stringify(fixture), PREVIEW_PROTECTION_BYPASS: bypass }
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("pnpm", ["exec", "playwright", "test", "--config=playwright.preview.config.ts", ...(process.argv.includes("--headed") ? ["--headed"] : [])], { env, stdio: "inherit" })
      child.on("error", reject); child.on("exit", resolve)
    })
    if (code !== 0) throw new Error("Preview browser checks failed")
    passed = true
  } finally {
    try { if (bootstrapped) { await operation("teardown"); cleaned = true } }
    finally {
      await browser.close(); await rm(dir, { recursive: true, force: true })
      await mkdir("preview-report", { recursive: true })
      await writeFile("preview-report/summary.json", JSON.stringify({ ...target, runId, passed, cleaned, finishedAt: new Date().toISOString() }, null, 2))
    }
  }
}
main().catch(() => { console.error("Preview validation failed; see sanitized summary and check configuration. No credentials are included in this error."); process.exitCode = 1 })
