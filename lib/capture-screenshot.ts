/**
 * Screenshot capture in a Vercel Sandbox, using the headless Chromium baked into
 * the agent's golden snapshot.
 *
 * One library, two kinds of caller: the `capture_screenshot` MCP tool the agent
 * invokes, and artifact thumbnails (lib/artifact-thumbnail.ts — captured in the
 * background when a link is saved, or on request from the artifact page). Both want the same
 * thing — "give me a PNG of this URL" — and neither should own browser
 * mechanics.
 *
 * WHY A SANDBOX AT ALL — Chromium cannot run in a Next.js serverless function,
 * and rendering caller-supplied URLs is exactly the work that belongs off the
 * application host. The sandbox is a separate VM with no access to our database
 * credentials or VPC, so a hostile page renders somewhere it can do no harm.
 *
 * COST — each capture boots its own sandbox (~200ms warm) and stops it in a
 * `finally`. A sandbox is not reused across captures: the isolation above is the
 * point, and a page that wedges the browser then costs one capture rather than
 * poisoning a shared instance.
 */

import { bootSandboxFromSnapshot, CHROMIUM_LAUNCH_ARGS } from "@/lib/agent-sandbox"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { buildSandboxedHtml } from "@/lib/artifact-preview-html"
import { isAutoBypassConfigured, leaseProtectionBypass, type BypassLease } from "@/lib/vercel-protection-bypass"

/** Bounds the whole capture, including boot. Independent of the page timeout. */
const CAPTURE_SANDBOX_TIMEOUT_MS = 2 * 60_000
const DEFAULT_PAGE_TIMEOUT_MS = 30_000
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const

/**
 * A freshly minted bypass key can reach Vercel's edge a moment after the API
 * confirms it, so a 401/403 on a leased key is retried (same key) after these
 * delays before being reported as a real failure.
 */
const LEASED_KEY_RETRY_DELAYS_MS = [2_000, 5_000]

/** Sandbox-relative paths; `writeFiles` resolves these under /vercel/sandbox. */
const CAPTURE_SCRIPT_PATH = "capture.mjs"
const CAPTURE_OUTPUT_PATH = "capture.png"
const CAPTURE_HTML_PATH = "capture.html"

/** Marks the script's structured result so log noise cannot be misparsed. */
const RESULT_MARKER = "__CAPTURE_RESULT__"

/**
 * What to render: exactly one of a URL or an HTML document.
 *
 * HTML MODE exists for HTML_UPLOAD artifacts, whose bytes live in private Blob
 * storage behind no URL Chromium could reach. Rather than mint one (a signed or
 * session-less route serving hostile uploaded HTML is something we deliberately
 * do not build), the bytes are handed to the browser directly:
 *
 *  - The document is wrapped in the same Content-Security-Policy the in-app
 *    preview iframe uses (buildSandboxedHtml), so the thumbnail shows what a
 *    reviewer sees — including what the policy blocks.
 *  - EVERY network request is aborted, belt-and-braces with that CSP. Uploaded
 *    HTML has no business fetching anything, and the sandbox's egress is not a
 *    resource we lend to it.
 *  - The bypass secret is unrepresentable here (`protectionBypassSecret?: never`)
 *    and rejected at runtime too: there is no origin it could be scoped to.
 */
type CaptureTarget =
  | {
      /** Absolute http(s) URL to render. */
      url: string
      html?: never
      /**
       * Vercel Deployment Protection bypass secret.
       *
       * Attached ONLY to requests whose origin matches `url`'s origin — never to
       * cross-origin subresources or to the target of a cross-origin redirect. The
       * obvious implementation (`setExtraHTTPHeaders`) cannot make that distinction:
       * it stamps the header on every request the page makes, so a page that embeds
       * a third-party script hands our bypass secret to that third party. That is
       * unacceptable, so the header is injected per-request instead.
       */
      protectionBypassSecret?: string
      /**
       * When no `protectionBypassSecret` is given, mint a short-lived bypass key on
       * the Vercel project that serves `url`, capture with it, and revoke it
       * (lib/vercel-protection-bypass.ts). Needs `VERCEL_ACCESS_TOKEN`; a host that
       * is not one of our team's projects gets no key. Ignored when a static secret
       * is supplied.
       */
      autoProtectionBypass?: boolean
    }
  | {
      /** A complete HTML document to render with no network access. */
      html: string
      url?: never
      protectionBypassSecret?: never
      autoProtectionBypass?: never
    }

export type CaptureScreenshotOptions = CaptureTarget & {
  viewport?: { width: number; height: number }
  /** Capture the entire scrollable page rather than just the viewport. */
  fullPage?: boolean
  /** Per-navigation timeout. Defaults to 30s. */
  timeoutMs?: number
}

export type CaptureScreenshotResult = {
  png: Buffer
  /** The URL actually rendered, after any redirects. `about:blank` in HTML mode. */
  finalUrl: string
  /** The main document's HTTP status. 0 in HTML mode, where there is no response. */
  httpStatus: number
  title: string
  /** The viewport rendered in — what was asked for, not what came out. */
  viewport: { width: number; height: number }
  /**
   * The PNG's own pixel dimensions, read from its header.
   *
   * NOT the same as `viewport`, and the difference matters: a `fullPage` capture
   * is as tall as the scrollable document, so anything storing or laying out the
   * image must use these numbers. Recording the viewport as the image size is an
   * easy mistake that produces thumbnails with the wrong aspect ratio.
   */
  image: { width: number; height: number }
  timings: { bootMs: number; captureMs: number; totalMs: number }
}

/** Thrown for every failure mode below, so callers can catch one type. */
export class ScreenshotCaptureError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "ScreenshotCaptureError"
  }
}

/**
 * Render `url` (or `html`) in the sandbox's headless Chromium and return the PNG.
 *
 * Throws ScreenshotCaptureError when the URL is not http(s), both or neither of
 * url/html are given, no golden snapshot exists, the page refuses to load, or the
 * browser produces no bytes.
 */
export async function captureScreenshot(
  options: CaptureScreenshotOptions
): Promise<CaptureScreenshotResult> {
  const startedAt = Date.now()
  const target = resolveTarget(options)
  const viewport = options.viewport ?? DEFAULT_VIEWPORT

  const snapshotId = await getGoldenSnapshotId()
  if (!snapshotId) {
    throw new ScreenshotCaptureError(
      "No golden sandbox snapshot is available, so there is no browser to capture with. " +
        "Build one with POST /api/admin/rebuild-agent-snapshot."
    )
  }

  // The lease is taken only once nothing else can fail cheaply (validation, snapshot),
  // and revoked in a `finally` that wraps everything that can use it.
  const lease = await maybeLeaseBypass(target, options)
  try {
    return await captureInSandbox({
      target,
      options,
      viewport,
      snapshotId,
      startedAt,
      bypassSecret: lease?.secret ?? options.protectionBypassSecret,
      retryAuthFailures: Boolean(lease),
    })
  } finally {
    await lease?.revoke()
  }
}

/**
 * Mint a per-capture bypass key when the caller asked for one, supplied no static
 * secret, and the feature is configured. Any failure to mint degrades to "capture
 * without a key": a public page still works, and a protected one reports its own
 * 401 — which is the pre-existing behaviour, not a new failure.
 */
async function maybeLeaseBypass(
  target: ResolvedTarget,
  options: CaptureScreenshotOptions
): Promise<BypassLease | null> {
  if (target.kind !== "url" || !options.autoProtectionBypass) return null
  if (options.protectionBypassSecret || !isAutoBypassConfigured()) return null
  try {
    return await leaseProtectionBypass(target.url.href)
  } catch (error) {
    console.warn(`[capture-screenshot] could not mint a protection-bypass key for ${target.label}: ${describe(error)}`)
    return null
  }
}

async function captureInSandbox(input: {
  target: ResolvedTarget
  options: CaptureScreenshotOptions
  viewport: { width: number; height: number }
  snapshotId: string
  startedAt: number
  bypassSecret: string | undefined
  retryAuthFailures: boolean
}): Promise<CaptureScreenshotResult> {
  const { target, options, viewport, snapshotId, startedAt, bypassSecret, retryAuthFailures } = input

  const bootStart = Date.now()
  let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>>
  try {
    sandbox = await bootSandboxFromSnapshot(snapshotId, {
      timeoutMs: CAPTURE_SANDBOX_TIMEOUT_MS,
      tags: { purpose: "screenshot-capture" },
    })
  } catch (error) {
    throw new ScreenshotCaptureError(
      `Could not boot a sandbox from snapshot ${snapshotId}: ${describe(error)}`,
      error
    )
  }
  const bootMs = Date.now() - bootStart

  try {
    const captureStart = Date.now()
    await sandbox.writeFiles([
      { path: CAPTURE_SCRIPT_PATH, content: CAPTURE_SCRIPT },
      // A file, not an env var: uploaded prototypes routinely exceed what an
      // environment block can carry, and this keeps the bytes out of /proc.
      ...(target.kind === "html" ? [{ path: CAPTURE_HTML_PATH, content: target.html }] : []),
    ])

    // Passed as env, not argv: argv is visible to every process in the
    // sandbox via /proc, and the bypass secret must not be.
    const commandOptions = {
      cmd: "node",
      args: [CAPTURE_SCRIPT_PATH],
      env: {
        CAPTURE_MODE: target.kind,
        CAPTURE_URL: target.kind === "url" ? target.url.href : "",
        CAPTURE_ORIGIN: target.kind === "url" ? target.url.origin : "",
        CAPTURE_HTML_PATH: target.kind === "html" ? CAPTURE_HTML_PATH : "",
        CAPTURE_OUTPUT: CAPTURE_OUTPUT_PATH,
        CAPTURE_VIEWPORT_WIDTH: String(viewport.width),
        CAPTURE_VIEWPORT_HEIGHT: String(viewport.height),
        CAPTURE_FULL_PAGE: options.fullPage ? "1" : "",
        CAPTURE_TIMEOUT_MS: String(options.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS),
        CAPTURE_BYPASS_SECRET: target.kind === "url" ? (bypassSecret ?? "") : "",
      },
      detached: true,
    }

    let output = ""
    for (let attempt = 0; ; attempt++) {
      const command = await sandbox.runCommand(commandOptions)
      output = ""
      for await (const log of command.logs()) output += log.data
      const result = await command.wait()
      if (result.exitCode === 0) break
      if (retryAuthFailures && attempt < LEASED_KEY_RETRY_DELAYS_MS.length && isAuthRejection(output)) {
        await new Promise(resolve => setTimeout(resolve, LEASED_KEY_RETRY_DELAYS_MS[attempt]))
        continue
      }
      throw new ScreenshotCaptureError(
        `Browser failed to capture ${target.label}: ${summarizeFailure(output)}`
      )
    }

    const meta = parseResultMarker(output)
    const png = await sandbox.readFileToBuffer({ path: CAPTURE_OUTPUT_PATH })
    if (!png || png.length === 0) {
      throw new ScreenshotCaptureError(
        `Browser reported success but produced no PNG for ${target.label}.`
      )
    }

    const captureMs = Date.now() - captureStart
    return {
      png,
      finalUrl: meta.finalUrl,
      httpStatus: meta.httpStatus,
      title: meta.title,
      viewport,
      image: readPngDimensions(png),
      timings: { bootMs, captureMs, totalMs: Date.now() - startedAt },
    }
  } finally {
    try {
      await sandbox.stop()
    } catch {
      // Best-effort: the sandbox's own timeout is the backstop, so a failed stop
      // costs money rather than correctness.
    }
  }
}

/**
 * Decide whether the Vercel protection-bypass secret may be sent to `url` at all.
 *
 * WHY THIS EXISTS, AND WHY ORIGIN-SCOPING INSIDE THE PAGE IS NOT ENOUGH — the
 * `page.route` interceptor in the capture script stops SUBRESOURCES on other
 * origins from seeing the header, but the main document always gets it. So if a
 * caller hands us `https://someone-elses-site.example` and a secret, we would
 * post our project-wide Deployment Protection secret straight to a third party.
 * Origin-scoping cannot catch that: the third party IS the target origin.
 *
 * Hence an allowlist of hosts the secret is meaningful for — our own
 * deployments, which are the only places it does anything. `CAPTURE_BYPASS_HOSTS`
 * extends it for cases like a custom domain; otherwise the platform-provided
 * hostnames are the whole list. Everything else captures with no header, which is
 * correct: a public page needs none, and a protected page that is not ours is not
 * ours to open.
 *
 * Returns the secret when it may be sent, and undefined otherwise — so a caller
 * can pass the result straight through without making the decision itself.
 */
export function resolveProtectionBypassSecret(url: string): string | undefined {
  const secret = process.env.MCP_BYPASS_SECRET
  if (!secret) return undefined

  let host: string
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    return undefined
  }

  const allowed = new Set(
    [
      process.env.VERCEL_URL,
      process.env.VERCEL_BRANCH_URL,
      process.env.VERCEL_PROJECT_PRODUCTION_URL,
      ...(process.env.CAPTURE_BYPASS_HOSTS ?? "").split(","),
    ]
      .map(value => value?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter((value): value is string => Boolean(value))
  )

  return allowed.has(host) ? secret : undefined
}

type ResolvedTarget =
  | { kind: "url"; url: URL; label: string }
  | { kind: "html"; html: string; label: string }

function resolveTarget(options: CaptureScreenshotOptions): ResolvedTarget {
  const hasUrl = typeof options.url === "string"
  const hasHtml = typeof options.html === "string"
  if (hasUrl === hasHtml) {
    throw new ScreenshotCaptureError("Pass exactly one of url or html to capture.")
  }
  if (hasHtml) {
    // The types already forbid this; the runtime check is for callers that went
    // around them. There is no origin to scope the secret to, so never send it.
    if (options.protectionBypassSecret) {
      throw new ScreenshotCaptureError("A protection-bypass secret cannot be used when capturing HTML.")
    }
    if (!options.html!.trim()) throw new ScreenshotCaptureError("Cannot capture an empty HTML document.")
    return { kind: "html", html: buildSandboxedHtml(options.html!), label: "the uploaded HTML" }
  }
  const url = parseCaptureUrl(options.url!)
  return { kind: "url", url, label: redactUrl(url) }
}

/** Only http(s) — `file://` and `data:` would turn this into a file reader. */
function parseCaptureUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ScreenshotCaptureError(`Not a valid absolute URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScreenshotCaptureError(
      `Only http and https URLs can be captured, got ${url.protocol}`
    )
  }
  return url
}

/**
 * Read a PNG's pixel dimensions out of its IHDR chunk.
 *
 * The header is fixed-layout — 8-byte signature, 4-byte length, "IHDR", then two
 * big-endian uint32s — so this is a 16-byte read, not image decoding, and needs no
 * dependency. Throws rather than returning zeros: a buffer this short is not a PNG,
 * and silently recording a 0×0 thumbnail would hide the failure downstream.
 */
function readPngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.toString("ascii", 12, 16) !== "IHDR") {
    throw new ScreenshotCaptureError(
      "Browser output is not a valid PNG (no IHDR header), so its dimensions cannot be read."
    )
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function parseResultMarker(output: string): {
  finalUrl: string
  httpStatus: number
  title: string
} {
  const line = output
    .split("\n")
    .reverse()
    .find(l => l.includes(RESULT_MARKER))
  if (!line) {
    throw new ScreenshotCaptureError(
      `Browser did not report a result: ${summarizeFailure(output)}`
    )
  }
  try {
    const parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length))
    return {
      finalUrl: String(parsed.finalUrl ?? ""),
      httpStatus: Number(parsed.httpStatus ?? 0),
      title: String(parsed.title ?? ""),
    }
  } catch (error) {
    throw new ScreenshotCaptureError(`Could not parse browser result: ${describe(error)}`, error)
  }
}

/** The in-sandbox script's wording for a 401/403 on the main document. */
function isAuthRejection(output: string): boolean {
  return /Page returned HTTP (401|403)/.test(output)
}

/** Last few non-empty lines — enough to diagnose without dumping a whole log. */
function summarizeFailure(output: string): string {
  const lines = output
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
  return lines.slice(-4).join(" | ") || "no output"
}

/** Query strings can carry tokens, so error text gets origin + path only. */
function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs inside the sandbox. Everything it needs arrives via env so that no
 * caller-supplied value is ever interpolated into this source.
 */
const CAPTURE_SCRIPT = `import { chromium } from "playwright-core"

import { readFileSync } from "node:fs"

const mode = process.env.CAPTURE_MODE
const url = process.env.CAPTURE_URL
const origin = process.env.CAPTURE_ORIGIN
const output = process.env.CAPTURE_OUTPUT
const bypassSecret = process.env.CAPTURE_BYPASS_SECRET || ""
const timeout = Number(process.env.CAPTURE_TIMEOUT_MS)
const fullPage = process.env.CAPTURE_FULL_PAGE === "1"
const viewport = {
  width: Number(process.env.CAPTURE_VIEWPORT_WIDTH),
  height: Number(process.env.CAPTURE_VIEWPORT_HEIGHT),
}

const browser = await chromium.launch({ args: ${JSON.stringify(CHROMIUM_LAUNCH_ARGS)} })
try {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()

  if (mode === "html") {
    // No network at all: abort every request on the context, so popups and
    // navigations are covered as well as subresources. data: and blob: URLs are
    // never routed, so inline assets still render.
    await context.route("**/*", route => route.abort())
    const html = readFileSync(process.env.CAPTURE_HTML_PATH, "utf8")
    await page.setContent(html, { waitUntil: "load", timeout })
    await page.waitForTimeout(250)
    await page.screenshot({ path: output, fullPage, type: "png" })
    console.log(
      "${RESULT_MARKER}" +
        JSON.stringify({ finalUrl: page.url(), httpStatus: 0, title: await page.title() })
    )
  } else {
  if (bypassSecret) {
    // Same-origin only. A cross-origin subresource or redirect target must not
    // receive the bypass secret.
    await page.route("**/*", async route => {
      const request = route.request()
      if (new URL(request.url()).origin === origin) {
        await route.continue({
          headers: { ...request.headers(), "x-vercel-protection-bypass": bypassSecret },
        })
      } else {
        await route.continue()
      }
    })
  }

  const response = await page.goto(url, { waitUntil: "load", timeout })
  const httpStatus = response ? response.status() : 0

  if (httpStatus === 401 || httpStatus === 403) {
    throw new Error(
      "Page returned HTTP " + httpStatus + " (not authorized). If this is a protected Vercel " +
      "deployment, the protection-bypass secret is missing, stale, or wrong."
    )
  }
  if (httpStatus >= 400) {
    throw new Error("Page returned HTTP " + httpStatus)
  }

  // Best-effort settle for late-loading content. Deliberately not a
  // \`waitUntil: "networkidle"\` navigation: a page holding any long-lived
  // connection never reaches network-idle, and failing the capture over that
  // would be wrong when the page is perfectly renderable.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})

  await page.screenshot({ path: output, fullPage, type: "png" })

  console.log(
    "${RESULT_MARKER}" +
      JSON.stringify({ finalUrl: page.url(), httpStatus, title: await page.title() })
  )
  }
} finally {
  await browser.close()
}
`
