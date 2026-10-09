import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
const prisma = {
  artifact: { findFirst: vi.fn() },
  artifactRevision: { findFirst: vi.fn(), update: vi.fn() },
  artifactBlobCleanup: { upsert: vi.fn() },
}
const captureScreenshot = vi.fn()
const resolveProtectionBypassSecret = vi.fn()

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => storage }))
vi.mock("@/lib/capture-screenshot", () => ({
  captureScreenshot: (...args: unknown[]) => captureScreenshot(...args),
  resolveProtectionBypassSecret: (...args: unknown[]) => resolveProtectionBypassSecret(...args),
}))

import { captureArtifactScreenshot } from "@/lib/artifact-tool-handlers"

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const capturedAt = new Date("2026-10-01T12:00:00Z")

function capture(overrides: Record<string, unknown> = {}) {
  return {
    png: PNG, finalUrl: "https://a.example/final", httpStatus: 200, title: "Page",
    viewport: { width: 1280, height: 800 }, image: { width: 1280, height: 1900 },
    timings: { bootMs: 1, captureMs: 2, totalMs: 3 }, ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.put.mockImplementation(async (pathname: string) => ({ pathname }))
  // First findFirst: the handler's own revision lookup. Second: setArtifactRevisionThumbnail's.
  prisma.artifactRevision.findFirst
    .mockResolvedValueOnce({ id: "rev-1", revisionNumber: 3, externalUrl: null, blobPathname: "artifacts/ws-1/art-1/rev-1.html" })
    .mockResolvedValueOnce({ id: "rev-1", thumbnailPathname: null })
  prisma.artifactRevision.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "rev-1", revisionNumber: 3, thumbnailByteSize: PNG.byteLength,
    thumbnailWidth: data.thumbnailWidth, thumbnailHeight: data.thumbnailHeight,
    thumbnailCapturedAt: capturedAt, thumbnailSourceUrl: data.thumbnailSourceUrl,
  }))
  captureScreenshot.mockResolvedValue(capture({ finalUrl: "about:blank", httpStatus: 0 }))
})

function mockArtifact(sourceType: string) {
  prisma.artifact.findFirst.mockResolvedValue({ id: "art-1", sourceType, currentRevisionId: "rev-1" })
}

describe("captureArtifactScreenshot — HTML_UPLOAD", () => {
  it("renders the stored HTML bytes with no URL and no bypass secret", async () => {
    mockArtifact("HTML_UPLOAD")
    storage.get.mockResolvedValue(new TextEncoder().encode("<html><body>Proto</body></html>"))

    const result = await captureArtifactScreenshot({ artifactId: "art-1", workspaceId: "ws-1", fullPage: true })

    expect(storage.get).toHaveBeenCalledWith("artifacts/ws-1/art-1/rev-1.html")
    expect(captureScreenshot).toHaveBeenCalledWith({ html: "<html><body>Proto</body></html>", fullPage: true, viewport: undefined })
    expect(resolveProtectionBypassSecret).not.toHaveBeenCalled()

    const update = prisma.artifactRevision.update.mock.calls[0][0]
    expect(update.data.thumbnailSourceUrl).toBeNull()
    expect(update.data.thumbnailWidth).toBe(1280)
    expect(update.data.thumbnailHeight).toBe(1900)

    const text = result.content[0].text
    expect(text).toContain("Rendered: the uploaded HTML (network access disabled)")
    expect(text).toMatch(/\nID: art-1$/)
    expect(result.structuredContent.data).toMatchObject({ sourceUrl: null, httpStatus: null, revisionNumber: 3 })
    // Storage pathnames never leave the handler.
    expect(JSON.stringify(result)).not.toContain("artifacts/ws-1")
  })

  it("fails when the uploaded HTML is missing from storage", async () => {
    mockArtifact("HTML_UPLOAD")
    storage.get.mockResolvedValue(null)
    const result = await captureArtifactScreenshot({ artifactId: "art-1", workspaceId: "ws-1" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/could not be read from storage/)
    expect(captureScreenshot).not.toHaveBeenCalled()
  })
})

describe("captureArtifactScreenshot — EXTERNAL_LINK", () => {
  it("captures the URL with the allowlisted bypass secret and records the final URL", async () => {
    mockArtifact("EXTERNAL_LINK")
    prisma.artifactRevision.findFirst.mockReset()
      .mockResolvedValueOnce({ id: "rev-1", revisionNumber: 1, externalUrl: "https://a.example/start", blobPathname: null })
      .mockResolvedValueOnce({ id: "rev-1", thumbnailPathname: null })
    resolveProtectionBypassSecret.mockReturnValue("bypass")
    captureScreenshot.mockResolvedValue(capture())

    const result = await captureArtifactScreenshot({ artifactId: "art-1", workspaceId: "ws-1" })

    expect(resolveProtectionBypassSecret).toHaveBeenCalledWith("https://a.example/start")
    expect(captureScreenshot).toHaveBeenCalledWith(expect.objectContaining({ url: "https://a.example/start", protectionBypassSecret: "bypass" }))
    expect(prisma.artifactRevision.update.mock.calls[0][0].data.thumbnailSourceUrl).toBe("https://a.example/final")
    expect(result.content[0].text).toContain("Rendered: https://a.example/final (HTTP 200)")
    expect(result.content[0].text).toContain("ID: art-1")
    expect(JSON.stringify(result)).not.toContain("bypass")
  })
})

describe("captureArtifactScreenshot — unsupported", () => {
  it("rejects other source types before capturing", async () => {
    mockArtifact("FIGMA")
    const result = await captureArtifactScreenshot({ artifactId: "art-1", workspaceId: "ws-1" })
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toMatch(/not supported for FIGMA/)
    expect(captureScreenshot).not.toHaveBeenCalled()
  })

  it("reports an unknown artifact", async () => {
    prisma.artifact.findFirst.mockResolvedValue(null)
    const result = await captureArtifactScreenshot({ artifactId: "nope", workspaceId: "ws-1" })
    expect(result.content[0].text).toMatch(/not found/)
  })
})
