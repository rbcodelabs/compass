import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  after: vi.fn(),
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  captureScreenshot: vi.fn(),
  setThumbnail: vi.fn(),
  createExternal: vi.fn(),
  createHtml: vi.fn(),
  replaceExternal: vi.fn(),
  replaceHtml: vi.fn(),
  prisma: {
    workspace: { findFirst: vi.fn() },
    artifact: { findFirst: vi.fn() },
    artifactRevision: { findFirst: vi.fn() },
  },
}))

vi.mock("next/server", () => ({ after: m.after }))
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }))
vi.mock("@/auth", () => ({ auth: m.auth }))
vi.mock("@/lib/db", () => ({ default: () => m.prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }) }))
vi.mock("@/lib/capture-screenshot", () => ({
  captureScreenshot: m.captureScreenshot,
  resolveProtectionBypassSecret: () => undefined,
}))
vi.mock("@/lib/artifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts")>()),
  setArtifactRevisionThumbnail: m.setThumbnail,
  createExternalArtifact: m.createExternal,
  createHtmlArtifact: m.createHtml,
  replaceExternalArtifactRevision: m.replaceExternal,
  replaceHtmlArtifactRevision: m.replaceHtml,
}))

import { scheduleArtifactThumbnailCapture } from "@/lib/artifact-thumbnail"
import { createArtifact as mcpCreateArtifact, updateArtifact as mcpUpdateArtifact } from "@/lib/artifact-tool-handlers"
import { captureArtifactThumbnail, createArtifact, replaceArtifactRevision } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

const capture = {
  png: Buffer.from("png"), finalUrl: "https://a.example/", httpStatus: 200, title: "A",
  viewport: { width: 1280, height: 800 }, image: { width: 1280, height: 800 },
  timings: { bootMs: 1, captureMs: 1, totalMs: 2 },
}

/** Run every callback handed to after(), the way Next.js does once the response is sent. */
async function flushAfter() {
  for (const [callback] of m.after.mock.calls) await (callback as () => Promise<void>)()
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ARTIFACT_AUTO_THUMBNAILS
  m.auth.mockResolvedValue({ user: { id: "user-1" } })
  m.prisma.workspace.findFirst.mockResolvedValue({ id: "ws-1" })
  m.prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType: "EXTERNAL_LINK", currentRevisionId: "rev-1" })
  m.prisma.artifactRevision.findFirst.mockResolvedValue({ id: "rev-1", revisionNumber: 1, externalUrl: "https://a.example/", blobPathname: null })
  m.captureScreenshot.mockResolvedValue(capture)
  m.setThumbnail.mockResolvedValue({ id: "rev-1", revisionNumber: 1 })
  m.createExternal.mockResolvedValue({ id: "art-1", title: "A", currentRevisionId: "rev-1" })
  m.createHtml.mockResolvedValue({ id: "art-2", title: "H", currentRevisionId: "rev-h" })
  m.replaceExternal.mockResolvedValue({ id: "rev-2" })
  m.replaceHtml.mockResolvedValue({ id: "rev-h2" })
})

afterEach(() => { delete process.env.ARTIFACT_AUTO_THUMBNAILS })

describe("scheduleArtifactThumbnailCapture", () => {
  it("defers the capture until after the response, then stores it for the given revision", async () => {
    scheduleArtifactThumbnailCapture({ artifactId: "art-1", workspaceId: "ws-1", revisionId: "rev-1" })
    expect(m.captureScreenshot).not.toHaveBeenCalled()
    await flushAfter()
    expect(m.prisma.artifactRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rev-1", artifactId: "art-1" } }))
    expect(m.captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ url: "https://a.example/" }))
    expect(m.setThumbnail).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "art-1", workspaceId: "ws-1", revisionId: "rev-1" }), expect.anything())
  })

  it("logs and swallows a failed capture — saving the link must not fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    m.captureScreenshot.mockRejectedValue(new Error("Page returned HTTP 500"))
    scheduleArtifactThumbnailCapture({ artifactId: "art-1", workspaceId: "ws-1", revisionId: "rev-1" })
    await expect(flushAfter()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Page returned HTTP 500"))
    expect(m.setThumbnail).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("can be switched off with ARTIFACT_AUTO_THUMBNAILS=off", () => {
    process.env.ARTIFACT_AUTO_THUMBNAILS = "off"
    scheduleArtifactThumbnailCapture({ artifactId: "art-1", workspaceId: "ws-1", revisionId: "rev-1" })
    expect(m.after).not.toHaveBeenCalled()
  })
})

describe("MCP create/update schedule a capture for external links only", () => {
  it("create_artifact EXTERNAL_LINK schedules the new revision", async () => {
    const result = await mcpCreateArtifact({ workspaceId: "ws-1", title: "A", sourceType: "EXTERNAL_LINK", url: "https://a.example/" })
    expect(result.structuredContent.ok).toBe(true)
    expect(m.after).toHaveBeenCalledTimes(1)
    await flushAfter()
    expect(m.setThumbnail).toHaveBeenCalledWith(expect.objectContaining({ revisionId: "rev-1" }), expect.anything())
  })

  it("create_artifact HTML_UPLOAD does not schedule one", async () => {
    await mcpCreateArtifact({ workspaceId: "ws-1", title: "H", sourceType: "HTML_UPLOAD", html: "<p>hi</p>" })
    expect(m.after).not.toHaveBeenCalled()
  })

  it("update_artifact with a new url schedules that revision", async () => {
    await mcpUpdateArtifact({ artifactId: "art-1", workspaceId: "ws-1", url: "https://b.example/" })
    expect(m.after).toHaveBeenCalledTimes(1)
    m.prisma.artifactRevision.findFirst.mockResolvedValue({ id: "rev-2", revisionNumber: 2, externalUrl: "https://b.example/", blobPathname: null })
    await flushAfter()
    expect(m.prisma.artifactRevision.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "rev-2", artifactId: "art-1" } }))
  })

  it("update_artifact with only metadata does not schedule one", async () => {
    await mcpUpdateArtifact({ artifactId: "art-1", workspaceId: "ws-1", title: "Renamed" }).catch(() => {})
    expect(m.after).not.toHaveBeenCalled()
  })
})

describe("UI actions", () => {
  function form(entries: Record<string, string>) {
    const data = new FormData()
    for (const [key, value] of Object.entries(entries)) data.set(key, value)
    return data
  }

  it("createArtifact schedules a capture for an external link", async () => {
    await createArtifact("ws-1", form({ title: "A", sourceType: "EXTERNAL_LINK", url: "https://a.example/" }), "/o/w/docs")
    expect(m.after).toHaveBeenCalledTimes(1)
  })

  it("replaceArtifactRevision schedules the new external revision", async () => {
    await replaceArtifactRevision("ws-1", "art-1", "EXTERNAL_LINK", form({ url: "https://b.example/" }), "/o/w/docs")
    expect(m.after).toHaveBeenCalledTimes(1)
  })

  it("captureArtifactThumbnail captures inline and revalidates on success", async () => {
    await expect(captureArtifactThumbnail("ws-1", "art-1", "/o/w/docs/artifacts/art-1")).resolves.toEqual({ ok: true })
    expect(m.captureScreenshot).toHaveBeenCalledTimes(1)
    expect(m.after).not.toHaveBeenCalled()
    expect(m.revalidatePath).toHaveBeenCalledWith("/o/w/docs/artifacts/art-1")
  })

  it("captureArtifactThumbnail returns a known capture failure's message", async () => {
    const failure = Object.assign(new Error("Page returned HTTP 404"), { name: "ScreenshotCaptureError" })
    m.captureScreenshot.mockRejectedValue(failure)
    await expect(captureArtifactThumbnail("ws-1", "art-1", "/p")).resolves.toEqual({ ok: false, error: "Page returned HTTP 404" })
    expect(m.revalidatePath).not.toHaveBeenCalled()
  })

  it("captureArtifactThumbnail hides an unexpected error's details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    m.setThumbnail.mockRejectedValue(new Error("connection reset by db-host-123"))
    await expect(captureArtifactThumbnail("ws-1", "art-1", "/p")).resolves.toEqual({ ok: false, error: "Could not capture a screenshot of this artifact." })
    error.mockRestore()
  })

  it("captureArtifactThumbnail rejects a non-member before capturing", async () => {
    m.prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(captureArtifactThumbnail("ws-1", "art-1", "/p")).rejects.toThrow("Workspace not found or access denied")
    expect(m.captureScreenshot).not.toHaveBeenCalled()
  })
})
