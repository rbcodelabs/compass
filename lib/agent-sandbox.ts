/**
 * Reusable Vercel Sandbox mechanics for the in-app agent runtime.
 *
 * Productionizes the throwaway spike (branch feat/agent-sdk-sandbox-spike):
 *  - `buildGoldenSnapshot()` — create a sandbox, `npm install` the agent deps,
 *    and `session.snapshot()` it, so agent turns can boot warm (~200ms) instead
 *    of paying the ~10s cold install every turn.
 *  - `bootSandboxFromSnapshot()` — the warm boot path used by the turn service.
 *  - `deleteGoldenSnapshot()` — delete a golden snapshot from Vercel Sandbox
 *    storage. Every rebuild leaves the *previous* golden snapshot orphaned
 *    unless the caller explicitly deletes it (see
 *    POST /api/admin/rebuild-agent-snapshot, which does this after the new
 *    snapshot is confirmed persisted) — each one is ~450MB, and left
 *    unattended these silently accumulate until the team's Snapshot Storage
 *    quota is exceeded and Vercel starts rejecting ALL sandbox creation
 *    account-wide with a 402.
 *
 * DESIGN NOTE — only DEPENDENCIES are baked into the snapshot, not the agent
 * entry script. The entry script is written per-turn (cheap) in Phase 3, so
 * iterating on agent logic does NOT require a snapshot rebuild — only changing
 * the snapshot recipe does. `computeDepsFingerprint()` captures exactly that
 * surface, and AgentRuntimeConfig.depsFingerprint records which recipe a
 * snapshot was built from (drift detection). See docs/decisions/0001-…§3.
 *
 * Secrets are NEVER written during the build — they are passed at runCommand
 * time on the warm path only, so no secret enters a snapshot's filesystem.
 *
 * BROWSER — the snapshot also bakes a headless Chromium, used two
 * ways: host-side capture in lib/capture-screenshot.ts, and directly by the
 * agent via Bash. Chromium arrives DECLARATIVELY, as the
 * `@playwright/browser-chromium` dependency whose install hook downloads only
 * Chromium (not Firefox/WebKit) and pins `playwright-core` to the identical
 * version. That matters: the obvious alternative — `npx playwright install
 * chromium` — resolves the CLI from the registry independently of the runtime
 * library, so the two can drift to different versions and the browser is then
 * only findable by filesystem search. Keeping the browser in package.json also
 * means the existing fingerprint covers it for free.
 *
 * Because the install hook is what fetches the browser, `npm install` here must
 * never gain `--ignore-scripts`: that would silently produce a browserless
 * snapshot. The build's own smoke check (below) is what catches that.
 */

import { createHash } from "node:crypto"
import { Sandbox, Snapshot } from "@vercel/sandbox"

export const SANDBOX_RUNTIME = "node24"
const SANDBOX_TIMEOUT_MS = 5 * 60_000

/**
 * The build does far more work than a turn does — a `dnf` transaction, an npm
 * install that pulls a ~150MB browser, and two Chromium launches — so it gets
 * its own, longer budget. The 5-minute default stays where it belongs: bounding
 * warm boots that run per turn.
 */
const SNAPSHOT_BUILD_TIMEOUT_MS = 15 * 60_000

/** Pinned exactly: the browser payload and the library that drives it must match. */
const PLAYWRIGHT_VERSION = "1.61.0"

/**
 * Shared libraries headless Chromium dlopen()s at startup, absent from the
 * Amazon Linux 2023 base image. Installed with `dnf` (so: `sudo: true`).
 * Playwright's own `install --with-deps` only knows Debian/Ubuntu, which is why
 * this list is maintained by hand.
 *
 * Part of the snapshot fingerprint — editing it forces a rebuild.
 */
export const SANDBOX_SYSTEM_PACKAGES: readonly string[] = [
  "alsa-lib",
  "atk",
  "cups-libs",
  "gtk3",
  "libXcomposite",
  "libXdamage",
  "libXrandr",
  "mesa-libgbm",
  "nspr",
  "nss",
  "pango",
]

/**
 * Flags headless Chromium needs inside a container: no user namespaces for its
 * own sandbox, and /dev/shm is too small for the default shared-memory backend.
 * Exported so every launch site (build smoke check, capture library, the
 * agent's own scripts) uses one definition.
 */
export const CHROMIUM_LAUNCH_ARGS: readonly string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
]

/**
 * Single source of truth for the sandbox's dependency set. Changing this is
 * what necessitates a golden-snapshot rebuild (via
 * POST /api/admin/rebuild-agent-snapshot).
 *
 * NOTE — `PLAYWRIGHT_BROWSERS_PATH` is deliberately NOT set anywhere. Left
 * unset, the install hook writes to playwright-core's own default cache and the
 * runtime reads from that same default, so build and run agree by construction
 * with no env var to keep in sync across two code paths.
 */
export const SANDBOX_DEPENDENCIES: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk": "0.3.224",
  "@modelcontextprotocol/sdk": "^1.29.0",
  "@playwright/browser-chromium": PLAYWRIGHT_VERSION,
  "playwright-core": PLAYWRIGHT_VERSION,
  zod: "^4.0.0",
}

/** The canonical package.json installed inside the sandbox (deps only). */
export function sandboxPackageJson(): string {
  return JSON.stringify(
    { name: "agent-sandbox", private: true, type: "module", dependencies: SANDBOX_DEPENDENCIES },
    null,
    2
  )
}

/**
 * Everything that determines a snapshot's contents. Wider than package.json:
 * the system libraries and the runtime are baked in too, and a change to either
 * is just as stale-making as a dependency bump. `recipeVersion` is bumped when
 * the build steps themselves change in a way npm can't express, which also
 * guarantees every previously stored fingerprint mismatches and rebuilds.
 */
function snapshotRecipe(): string {
  return JSON.stringify({
    recipeVersion: 2,
    runtime: SANDBOX_RUNTIME,
    packageJson: sandboxPackageJson(),
    systemPackages: SANDBOX_SYSTEM_PACKAGES,
  })
}

/**
 * SHA-256 of the canonical snapshot recipe. Records what a golden snapshot was
 * built from; a mismatch means the snapshot is stale.
 *
 * Named `depsFingerprint` for history, not accuracy — it now covers the system
 * libraries and runtime as well, and the AgentRuntimeConfig column of the same
 * name is the persisted form. Renaming both is a mechanical change deliberately
 * deferred while several agent-runtime branches are in flight.
 */
export function computeDepsFingerprint(): string {
  return createHash("sha256").update(snapshotRecipe()).digest("hex")
}

/** Written, run, and deleted during the build; never part of the snapshot. */
const BROWSER_SMOKE_PATH = "browser-smoke.mjs"

/**
 * Launches the baked Chromium and takes a real screenshot. Run before the
 * snapshot is taken (does the browser work at all?) and again after booting
 * from it (did the browser survive the snapshot round-trip?) — the second
 * question is the one that cannot be answered any other way, since whether a
 * cache directory is captured is a property of the platform, not of this code.
 */
const BROWSER_SMOKE_SCRIPT = `import { chromium } from "playwright-core"

const browser = await chromium.launch({ args: ${JSON.stringify(CHROMIUM_LAUNCH_ARGS)} })
try {
  const version = browser.version()
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.setContent("<h1>compass sandbox browser smoke</h1>")
  const shot = await page.screenshot({ type: "png" })
  if (!shot || shot.length === 0) throw new Error("screenshot produced no bytes")
  console.log("chromium ok version=" + version + " pngBytes=" + shot.length)
} finally {
  await browser.close()
}
`

export type BuildSnapshotResult = {
  snapshotId: string
  depsFingerprint: string
  sizeBytes: number
  browserVersion: string
  timings: {
    createMs: number
    systemDepsMs: number
    installMs: number
    smokeMs: number
    snapshotMs: number
    verifyMs: number
    totalMs: number
  }
}

/**
 * Run a command to completion, streaming its output to `emit`, and throw on a
 * non-zero exit. Streaming matters for the slow steps here (`dnf`, `npm
 * install`): the rebuild endpoint reports progress live, and a failure shows
 * the package manager's own diagnostics rather than just an exit code.
 */
async function runStep(
  sandbox: Sandbox,
  label: string,
  params: { cmd: string; args: string[]; sudo?: boolean },
  emit: (line: string) => void
): Promise<string> {
  const command = await sandbox.runCommand({ ...params, detached: true })
  let output = ""
  for await (const log of command.logs()) {
    output += log.data
    emit(`[${label}:${log.stream}] ${log.data.trimEnd()}`)
  }
  const result = await command.wait()
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode}`)
  }
  return output
}

/**
 * Build a golden snapshot: fresh sandbox → system libraries → `npm install`
 * (which also fetches Chromium) → browser smoke check → `session.snapshot()` →
 * verify the browser still works when booted from that snapshot.
 *
 * Note `snapshot()` stops the session, so no agent is run and no secret is
 * present. Returns the new snapshot id + the fingerprint it was built from.
 *
 * Both browser checks are deliberate: a snapshot that boots but cannot launch
 * Chromium is indistinguishable from a good one until an agent turn or a
 * thumbnail job fails on it, by which point the broken snapshot is already live
 * for every user. Failing the build instead keeps the previous snapshot in
 * place, since the caller only persists a snapshot id this function returned.
 */
export async function buildGoldenSnapshot(opts?: {
  onProgress?: (line: string) => void
}): Promise<BuildSnapshotResult> {
  const emit = opts?.onProgress ?? (() => {})
  const startedAt = Date.now()
  let sandbox: Sandbox | undefined
  let snapshotted = false
  try {
    const createStart = Date.now()
    sandbox = await Sandbox.create({
      runtime: SANDBOX_RUNTIME,
      timeout: SNAPSHOT_BUILD_TIMEOUT_MS,
    })
    const createMs = Date.now() - createStart
    emit(`sandbox created: ${sandbox.name} (${createMs}ms)`)

    emit(`installing ${SANDBOX_SYSTEM_PACKAGES.length} system libraries for Chromium...`)
    const systemDepsStart = Date.now()
    await runStep(
      sandbox,
      "dnf",
      { cmd: "dnf", args: ["-y", "install", ...SANDBOX_SYSTEM_PACKAGES], sudo: true },
      emit
    )
    const systemDepsMs = Date.now() - systemDepsStart
    emit(`system libraries installed (${systemDepsMs}ms)`)

    await sandbox.writeFiles([{ path: "package.json", content: sandboxPackageJson() }])
    emit("wrote package.json; running npm install (includes Chromium download)...")

    const installStart = Date.now()
    await runStep(
      sandbox,
      "npm",
      { cmd: "npm", args: ["install", "--no-audit", "--no-fund"] },
      emit
    )
    const installMs = Date.now() - installStart
    emit(`npm install finished (${installMs}ms)`)

    emit("smoke-checking Chromium before snapshotting...")
    const smokeStart = Date.now()
    const smokeOutput = await runBrowserSmokeCheck(sandbox, "smoke", emit)
    const smokeMs = Date.now() - smokeStart
    const browserVersion = parseBrowserVersion(smokeOutput)
    emit(`Chromium works: version ${browserVersion} (${smokeMs}ms)`)

    // Keep the snapshot dependencies-only, per the design note above.
    await runStep(sandbox, "rm", { cmd: "rm", args: ["-f", BROWSER_SMOKE_PATH] }, emit)

    const snapStart = Date.now()
    const snap = await sandbox.currentSession().snapshot()
    const snapshotMs = Date.now() - snapStart
    snapshotted = true // snapshot() stops the session; do not stop() again
    emit(`snapshot created: ${snap.snapshotId} (${snapshotMs}ms, ${snap.sizeBytes} bytes)`)

    const verifyStart = Date.now()
    await verifySnapshotBrowser(snap.snapshotId, emit)
    const verifyMs = Date.now() - verifyStart
    emit(`snapshot verified: Chromium launches after warm boot (${verifyMs}ms)`)

    return {
      snapshotId: snap.snapshotId,
      depsFingerprint: computeDepsFingerprint(),
      sizeBytes: snap.sizeBytes,
      browserVersion,
      timings: {
        createMs,
        systemDepsMs,
        installMs,
        smokeMs,
        snapshotMs,
        verifyMs,
        totalMs: Date.now() - startedAt,
      },
    }
  } finally {
    if (sandbox && !snapshotted) {
      try {
        await sandbox.stop()
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** Write the smoke script into a sandbox, run it, and return its output. */
async function runBrowserSmokeCheck(
  sandbox: Sandbox,
  label: string,
  emit: (line: string) => void
): Promise<string> {
  await sandbox.writeFiles([{ path: BROWSER_SMOKE_PATH, content: BROWSER_SMOKE_SCRIPT }])
  return runStep(sandbox, label, { cmd: "node", args: [BROWSER_SMOKE_PATH] }, emit)
}

/**
 * Boot the freshly built snapshot and confirm Chromium still launches from it.
 * The browser lives in playwright-core's cache directory, and whether the
 * platform captures that directory is not something this code controls — so it
 * is observed once per rebuild rather than assumed.
 */
async function verifySnapshotBrowser(
  snapshotId: string,
  emit: (line: string) => void
): Promise<void> {
  const sandbox = await bootSandboxFromSnapshot(snapshotId, { timeoutMs: 2 * 60_000 })
  try {
    await runBrowserSmokeCheck(sandbox, "verify", emit)
  } catch (error) {
    throw new Error(
      `snapshot ${snapshotId} was created but Chromium does not launch when booted from it ` +
        `(the browser cache may not survive snapshotting): ${
          error instanceof Error ? error.message : String(error)
        }`
    )
  } finally {
    try {
      await sandbox.stop()
    } catch {
      // best-effort cleanup; the sandbox timeout is the backstop
    }
  }
}

/** Pull the reported browser version out of the smoke script's stdout. */
function parseBrowserVersion(smokeOutput: string): string {
  return smokeOutput.match(/chromium ok version=(\S+)/)?.[1] ?? "unknown"
}

/**
 * Boot a fresh sandbox FROM a golden snapshot (warm path). Dependencies are
 * already installed; the caller writes the per-turn entry script and runs it.
 *
 * `timeoutMs` shortens the sandbox lifetime for short-lived callers (the snapshot
 * smoke check and screenshot capture); `tags` labels it for cost attribution.
 */
export async function bootSandboxFromSnapshot(
  snapshotId: string,
  opts?: { timeoutMs?: number; tags?: Record<string, string> }
): Promise<Sandbox> {
  return Sandbox.create({
    source: { type: "snapshot", snapshotId },
    timeout: opts?.timeoutMs ?? SANDBOX_TIMEOUT_MS,
    ...(opts?.tags ? { tags: opts.tags } : {}),
  })
}

/**
 * Delete a golden snapshot from Vercel Sandbox storage.
 *
 * Callers MUST only invoke this for a snapshot that is no longer referenced
 * by AgentRuntimeConfig.goldenSnapshotId — deleting the *current* golden
 * snapshot would leave the agent runtime with nothing to boot from. The
 * rebuild route enforces this by persisting the new snapshot id first and
 * only deleting the previous one afterward.
 *
 * Uses the same OIDC/token credential resolution as `Sandbox.create()`
 * (no explicit team/project/token wiring needed here or in production).
 * Throws on failure — callers that consider deletion best-effort (the
 * rebuild route does) should catch and log rather than fail the request.
 */
export async function deleteGoldenSnapshot(snapshotId: string): Promise<void> {
  const snapshot = await Snapshot.get({ snapshotId })
  await snapshot.delete()
}
