import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = { doc: { findUnique: vi.fn() } }
const captureScreenshot = vi.fn()
const resolveCanvasCards = vi.fn()
const hydrateDocument = vi.fn()

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => ({ userId: "user-1" }) }))
vi.mock("@/lib/document-service", () => ({ hydrateDocument: (...a: unknown[]) => hydrateDocument(...a) }))
vi.mock("@/lib/canvas-card-data", () => ({ resolveCanvasCards: (...a: unknown[]) => resolveCanvasCards(...a) }))
vi.mock("@/lib/capture-screenshot", () => {
  class ScreenshotCaptureError extends Error {}
  return { captureScreenshot: (...a: unknown[]) => captureScreenshot(...a), ScreenshotCaptureError }
})

import { captureCanvas } from "@/lib/canvas-capture-tool-handlers"
import { ScreenshotCaptureError } from "@/lib/capture-screenshot"

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])
const OPP = "11111111-1111-4111-8111-111111111111"
const DOC_ID = "33333333-3333-4333-8333-333333333333"
const content = JSON.stringify({
  nodes: [
    { id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Hi" },
    { id: "c", type: "link", x: 300, y: 0, width: 280, height: 120, url: `compass://opportunity/${OPP}`, compass: { kind: "opportunity", id: OPP } },
  ],
  edges: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  prisma.doc.findUnique.mockResolvedValue({
    id: DOC_ID, title: "Board", docType: "CANVAS", workspaceId: "ws-1", content, contentRef: null, storageProvider: null,
    workspace: { slug: "ws", organization: { slug: "org" } },
  })
  hydrateDocument.mockImplementation(async (_ws: string, d: { content: string }) => ({ content: d.content }))
  resolveCanvasCards.mockResolvedValue({})
  captureScreenshot.mockResolvedValue({ png: PNG, image: { width: 800, height: 400 }, timings: { bootMs: 1, captureMs: 2, totalMs: 3 } })
})

describe("captureCanvas", () => {
  it("returns an image block plus structured content, without putting bytes in data", async () => {
    const result = await captureCanvas({ docId: DOC_ID })
    expect(result.structuredContent.ok).toBe(true)
    const image = result.content.find((c: { type: string }) => c.type === "image") as { data: string; mimeType: string }
    expect(image.mimeType).toBe("image/png")
    expect(Buffer.from(image.data, "base64").equals(PNG)).toBe(true)
    expect(result.structuredContent.ok).toBe(true)
    expect(JSON.stringify(result.structuredContent)).not.toContain(image.data)
    expect(result.structuredContent.data).toMatchObject({ docId: DOC_ID, view: "overview", byteSize: PNG.length, counts: { cards: 1 } })
  })

  it("resolves cards against the doc's own workspace, as the calling user", async () => {
    await captureCanvas({ docId: DOC_ID })
    expect(resolveCanvasCards).toHaveBeenCalledWith({
      workspaceId: "ws-1", orgSlug: "org", workspaceSlug: "ws", userId: "user-1", refs: [{ kind: "opportunity", id: OPP }],
    })
  })

  it("captures offline HTML sized to the view", async () => {
    await captureCanvas({ docId: DOC_ID, nodeId: "a", padding: 20 })
    const arg = captureScreenshot.mock.calls[0][0]
    expect(arg.url).toBeUndefined()
    expect(arg.html).toContain("<!doctype html>")
    expect(arg.viewport.width).toBeGreaterThan(0)
  })

  it("rejects nodeId together with region before touching the database", async () => {
    const result = await captureCanvas({ docId: DOC_ID, nodeId: "a", region: { x: 0, y: 0, width: 10, height: 10 } })
    expect(result.structuredContent.ok).toBe(false)
    expect(prisma.doc.findUnique).not.toHaveBeenCalled()
  })

  it("fails for missing docs and non-canvas docs", async () => {
    prisma.doc.findUnique.mockResolvedValueOnce(null)
    expect((await captureCanvas({ docId: DOC_ID })).structuredContent.ok).toBe(false)
    prisma.doc.findUnique.mockResolvedValueOnce({ id: DOC_ID, title: "Page", docType: "STANDARD", workspaceId: "ws-1" })
    const r = await captureCanvas({ docId: DOC_ID })
    expect(r.structuredContent.ok).toBe(false)
    expect(captureScreenshot).not.toHaveBeenCalled()
  })

  it("treats empty content as an empty canvas (a clear error, not a crash)", async () => {
    hydrateDocument.mockResolvedValueOnce({ content: null })
    const r = await captureCanvas({ docId: DOC_ID })
    expect(r.structuredContent.ok).toBe(false)
    expect(JSON.stringify(r.content)).toContain("no nodes")
  })

  it("reports an unknown node id without capturing", async () => {
    const r = await captureCanvas({ docId: DOC_ID, nodeId: "zzz" })
    expect(r.structuredContent.ok).toBe(false)
    expect(captureScreenshot).not.toHaveBeenCalled()
  })

  it("turns capture failures into a tool error", async () => {
    captureScreenshot.mockRejectedValueOnce(new ScreenshotCaptureError("No golden sandbox snapshot is available"))
    const r = await captureCanvas({ docId: DOC_ID })
    expect(r.structuredContent.ok).toBe(false)
    expect(JSON.stringify(r.content)).toContain("No golden sandbox snapshot")
  })
})
