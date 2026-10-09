import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getGoldenSnapshotId = vi.fn()
const bootSandboxFromSnapshot = vi.fn()
const leaseProtectionBypass = vi.fn()
const isAutoBypassConfigured = vi.fn()

vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: () => getGoldenSnapshotId() }))
vi.mock("@/lib/agent-sandbox", () => ({
  CHROMIUM_LAUNCH_ARGS: ["--no-sandbox"],
  bootSandboxFromSnapshot: (...args: unknown[]) => bootSandboxFromSnapshot(...args),
}))

vi.mock("@/lib/vercel-protection-bypass", () => ({
  isAutoBypassConfigured: () => isAutoBypassConfigured(),
  leaseProtectionBypass: (...args: unknown[]) => leaseProtectionBypass(...args),
}))

import { captureScreenshot, resolveProtectionBypassSecret, ScreenshotCaptureError } from "@/lib/capture-screenshot"
import { ARTIFACT_CSP } from "@/lib/artifact-preview-html"

/** A minimal PNG header: signature, IHDR length, "IHDR", width, height. */
function png(width: number, height: number) {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "ascii")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function fakeSandbox(result: Record<string, unknown> = { finalUrl: "https://a.example/", httpStatus: 200, title: "T" }) {
  const sandbox = {
    writeFiles: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue({
      async *logs() { yield { data: "noise\n__CAPTURE_RESULT__" + JSON.stringify(result) + "\n" } },
      wait: vi.fn().mockResolvedValue({ exitCode: 0 }),
    }),
    readFileToBuffer: vi.fn().mockResolvedValue(png(1280, 2400)),
    stop: vi.fn().mockResolvedValue(undefined),
  }
  bootSandboxFromSnapshot.mockResolvedValue(sandbox)
  return sandbox
}

function envOf(sandbox: ReturnType<typeof fakeSandbox>) {
  return sandbox.runCommand.mock.calls[0][0].env as Record<string, string>
}

beforeEach(() => {
  vi.clearAllMocks()
  getGoldenSnapshotId.mockResolvedValue("snap_1")
  isAutoBypassConfigured.mockReturnValue(true)
  leaseProtectionBypass.mockResolvedValue(null)
})

describe("captureScreenshot target validation", () => {
  it("rejects both url and html", async () => {
    // @ts-expect-error — the union forbids this; the runtime check is for callers that go around it
    await expect(captureScreenshot({ url: "https://a.example", html: "<p>x</p>" })).rejects.toThrow(/exactly one of url or html/)
    expect(bootSandboxFromSnapshot).not.toHaveBeenCalled()
  })

  it("rejects neither url nor html", async () => {
    // @ts-expect-error — see above
    await expect(captureScreenshot({})).rejects.toThrow(/exactly one of url or html/)
  })

  it("rejects a bypass secret in HTML mode", async () => {
    // @ts-expect-error — see above
    await expect(captureScreenshot({ html: "<p>x</p>", protectionBypassSecret: "s" })).rejects.toThrow(ScreenshotCaptureError)
    expect(bootSandboxFromSnapshot).not.toHaveBeenCalled()
  })

  it("rejects an empty HTML document", async () => {
    await expect(captureScreenshot({ html: "   " })).rejects.toThrow(/empty HTML/)
  })

  it("rejects non-http URLs", async () => {
    await expect(captureScreenshot({ url: "file:///etc/passwd" })).rejects.toThrow(/Only http and https/)
  })
})

describe("captureScreenshot HTML mode", () => {
  it("writes the CSP-wrapped document to a file and sends no URL or secret", async () => {
    const sandbox = fakeSandbox({ finalUrl: "about:blank", httpStatus: 0, title: "Proto" })
    const result = await captureScreenshot({ html: "<html><body>Proto</body></html>" })

    const files = sandbox.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>
    const html = files.find(f => f.path === "capture.html")
    expect(html).toBeDefined()
    expect(html!.content).toContain(ARTIFACT_CSP)
    expect(html!.content).toContain("Proto")

    const env = envOf(sandbox)
    expect(env.CAPTURE_MODE).toBe("html")
    expect(env.CAPTURE_HTML_PATH).toBe("capture.html")
    expect(env.CAPTURE_URL).toBe("")
    expect(env.CAPTURE_ORIGIN).toBe("")
    expect(env.CAPTURE_BYPASS_SECRET).toBe("")
    // The document travels as a file, never through env.
    expect(JSON.stringify(env)).not.toContain("Proto")

    expect(result.httpStatus).toBe(0)
    expect(result.image).toEqual({ width: 1280, height: 2400 })
    expect(sandbox.stop).toHaveBeenCalled()
  })

  it("aborts all network in the in-sandbox script", async () => {
    const sandbox = fakeSandbox()
    await captureScreenshot({ html: "<p>x</p>" })
    const files = sandbox.writeFiles.mock.calls[0][0] as Array<{ path: string; content: string }>
    const script = files.find(f => f.path === "capture.mjs")!.content
    expect(script).toContain('context.route("**/*", route => route.abort())')
    expect(script).toContain("page.setContent(html")
  })
})

describe("captureScreenshot URL mode", () => {
  it("passes the URL, origin and secret via env and writes no HTML file", async () => {
    const sandbox = fakeSandbox()
    const result = await captureScreenshot({ url: "https://a.example/page?q=1", protectionBypassSecret: "sekret" })
    const env = envOf(sandbox)
    expect(env.CAPTURE_MODE).toBe("url")
    expect(env.CAPTURE_URL).toBe("https://a.example/page?q=1")
    expect(env.CAPTURE_ORIGIN).toBe("https://a.example")
    expect(env.CAPTURE_BYPASS_SECRET).toBe("sekret")
    expect(sandbox.runCommand.mock.calls[0][0].args).not.toContain("sekret")
    const files = sandbox.writeFiles.mock.calls[0][0] as Array<{ path: string }>
    expect(files.map(f => f.path)).toEqual(["capture.mjs"])
    expect(result.httpStatus).toBe(200)
  })

  it("stops the sandbox and redacts the query string when the browser fails", async () => {
    const sandbox = fakeSandbox()
    sandbox.runCommand.mockResolvedValue({
      async *logs() { yield { data: "Error: Page returned HTTP 500\n" } },
      wait: vi.fn().mockResolvedValue({ exitCode: 1 }),
    })
    const error = await captureScreenshot({ url: "https://a.example/p?token=abc" }).then(() => { throw new Error("expected capture to fail") }, (e: unknown) => e as Error)
    expect(error).toBeInstanceOf(ScreenshotCaptureError)
    expect(error.message).toContain("https://a.example/p")
    expect(error.message).not.toContain("token=abc")
    expect(sandbox.stop).toHaveBeenCalled()
  })

  it("fails without a golden snapshot", async () => {
    getGoldenSnapshotId.mockResolvedValue(null)
    await expect(captureScreenshot({ url: "https://a.example" })).rejects.toThrow(/No golden sandbox snapshot/)
  })
})

describe("captureScreenshot auto protection bypass", () => {
  const lease = () => ({ projectId: "prj_1", secret: "leased-secret", revoke: vi.fn().mockResolvedValue(undefined) })
  const authFailure = () => ({
    async *logs() { yield { data: "Error: Page returned HTTP 401 (not authorized).\n" } },
    wait: vi.fn().mockResolvedValue({ exitCode: 1 }),
  })

  afterEach(() => { vi.useRealTimers() })

  it("mints a key, captures with it, and revokes it afterwards", async () => {
    const l = lease()
    leaseProtectionBypass.mockResolvedValue(l)
    const sandbox = fakeSandbox()
    await captureScreenshot({ url: "https://proto.vercel.app/x", autoProtectionBypass: true })
    expect(leaseProtectionBypass).toHaveBeenCalledWith("https://proto.vercel.app/x")
    expect(envOf(sandbox).CAPTURE_BYPASS_SECRET).toBe("leased-secret")
    expect(sandbox.runCommand.mock.calls[0][0].args).not.toContain("leased-secret")
    expect(l.revoke).toHaveBeenCalledTimes(1)
  })

  it("revokes even when the capture fails, and when the sandbox cannot boot", async () => {
    const l = lease()
    leaseProtectionBypass.mockResolvedValue(l)
    bootSandboxFromSnapshot.mockRejectedValue(new Error("no capacity"))
    await expect(captureScreenshot({ url: "https://proto.vercel.app", autoProtectionBypass: true })).rejects.toThrow(ScreenshotCaptureError)
    expect(l.revoke).toHaveBeenCalledTimes(1)
  })

  it("does not mint when a static secret is supplied, the flag is off, or the feature is unconfigured", async () => {
    fakeSandbox()
    await captureScreenshot({ url: "https://a.example", protectionBypassSecret: "static", autoProtectionBypass: true })
    await captureScreenshot({ url: "https://a.example" })
    isAutoBypassConfigured.mockReturnValue(false)
    await captureScreenshot({ url: "https://a.example", autoProtectionBypass: true })
    expect(leaseProtectionBypass).not.toHaveBeenCalled()
  })

  it("never mints for HTML captures", async () => {
    fakeSandbox()
    await captureScreenshot({ html: "<p>x</p>" })
    expect(leaseProtectionBypass).not.toHaveBeenCalled()
  })

  it("degrades to an unauthenticated capture when minting fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    leaseProtectionBypass.mockRejectedValue(new Error("Vercel API returned 403"))
    const sandbox = fakeSandbox()
    await captureScreenshot({ url: "https://proto.vercel.app", autoProtectionBypass: true })
    expect(envOf(sandbox).CAPTURE_BYPASS_SECRET).toBe("")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("retries a 401 on a leased key (propagation lag) and then succeeds", async () => {
    vi.useFakeTimers()
    const l = lease()
    leaseProtectionBypass.mockResolvedValue(l)
    const sandbox = fakeSandbox()
    const ok = await sandbox.runCommand()
    sandbox.runCommand.mockReset()
    sandbox.runCommand.mockResolvedValueOnce(authFailure()).mockResolvedValueOnce(ok)
    const pending = captureScreenshot({ url: "https://proto.vercel.app", autoProtectionBypass: true })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toMatchObject({ httpStatus: 200 })
    expect(sandbox.runCommand).toHaveBeenCalledTimes(2)
    expect(l.revoke).toHaveBeenCalledTimes(1)
  })

  it("gives up after the retries and reports the auth failure", async () => {
    vi.useFakeTimers()
    const l = lease()
    leaseProtectionBypass.mockResolvedValue(l)
    const sandbox = fakeSandbox()
    sandbox.runCommand.mockImplementation(async () => authFailure())
    const pending = captureScreenshot({ url: "https://proto.vercel.app", autoProtectionBypass: true })
    const assertion = expect(pending).rejects.toThrow(/HTTP 401/)
    await vi.advanceTimersByTimeAsync(7_000)
    await assertion
    expect(sandbox.runCommand).toHaveBeenCalledTimes(3)
    expect(l.revoke).toHaveBeenCalledTimes(1)
  })

  it("does not retry a 401 when no key was leased", async () => {
    const sandbox = fakeSandbox()
    sandbox.runCommand.mockImplementation(async () => authFailure())
    await expect(captureScreenshot({ url: "https://a.example", protectionBypassSecret: "static" })).rejects.toThrow(/HTTP 401/)
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1)
  })
})

describe("resolveProtectionBypassSecret", () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  beforeEach(() => {
    process.env.MCP_BYPASS_SECRET = "bypass"
    process.env.VERCEL_URL = "compass-abc.vercel.app"
    process.env.VERCEL_BRANCH_URL = "compass-git-x.vercel.app"
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    process.env.CAPTURE_BYPASS_HOSTS = "https://custom.example/, other.example"
  })

  it("returns the secret only for our own deployment hosts", () => {
    expect(resolveProtectionBypassSecret("https://compass-abc.vercel.app/login")).toBe("bypass")
    expect(resolveProtectionBypassSecret("https://COMPASS-GIT-X.vercel.app/")).toBe("bypass")
    expect(resolveProtectionBypassSecret("https://custom.example/a")).toBe("bypass")
    expect(resolveProtectionBypassSecret("https://other.example")).toBe("bypass")
  })

  it("withholds the secret from any other host", () => {
    expect(resolveProtectionBypassSecret("https://evil.example/")).toBeUndefined()
    expect(resolveProtectionBypassSecret("https://compass-abc.vercel.app.evil.example/")).toBeUndefined()
    expect(resolveProtectionBypassSecret("not a url")).toBeUndefined()
  })

  it("returns nothing when no secret is configured", () => {
    delete process.env.MCP_BYPASS_SECRET
    expect(resolveProtectionBypassSecret("https://compass-abc.vercel.app/")).toBeUndefined()
  })
})
