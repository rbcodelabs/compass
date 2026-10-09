import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CanvasOverview } from "@/lib/canvas/data"

const mockDoc = { findUnique: vi.fn() }
const mockWorkspace = { findUnique: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ doc: mockDoc, workspace: mockWorkspace }) }))

const updateDocument = vi.fn()
vi.mock("@/lib/document-service", () => {
  class DocumentError extends Error {
    constructor(public readonly code: string, detail?: string) {
      super(detail ?? code)
    }
  }
  return {
    DocumentError,
    documentRevision: (d: { revision?: string | null }) => d.revision ?? "legacy",
    hydrateDocument: async (_ws: string, row: object) => row,
    updateDocument: (...args: unknown[]) => updateDocument(...args),
  }
})
vi.mock("@/lib/document-mcp-actor", () => ({ documentMcpActor: () => ({ authorId: "u1", authorName: "MCP Agent", actorKey: "USER:u1" }) }))

const getCanvasOverview = vi.fn()
vi.mock("@/lib/canvas/data", () => ({ getCanvasOverview: (...args: unknown[]) => getCanvasOverview(...args) }))
const layoutTreeCards = vi.fn()
vi.mock("@/lib/canvas-tree-layout", () => ({ layoutTreeCards: (...args: unknown[]) => layoutTreeCards(...args) }))
vi.mock("@/lib/thinking-model/resolve", () => ({ resolveThinkingModel: () => ({ links: { oppToObjective: "shown" } }) }))

import { buildCanvasTree } from "@/lib/doc-edit-tool-handlers"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const [O1, KR1, OPP1] = [id(1), id(2), id(3)]

const overview = {
  objectives: [{ id: O1, title: "Grow", status: "ON_TRACK", squad: null, position: null }],
  keyResults: [{ id: KR1, objectiveId: O1, title: "KR", current: 0, target: 1, unit: null, position: null }],
  opportunities: [{ id: OPP1, title: "Opp", status: "EXPLORING", squad: null, linkedKeyResultId: KR1, position: null }],
  solutions: [],
  assumptions: [],
  experiments: [],
  roadmapItems: [],
} as unknown as CanvasOverview

const row = (content = '{"nodes":[],"edges":[]}', over: Record<string, unknown> = {}) => ({
  id: "d1", workspaceId: "w1", title: "T", docType: "CANVAS", content, revision: "r1", updatedAt: new Date(), ...over,
})
const saved = { id: "d1", title: "T", revision: "r2", updatedAt: new Date() }
const message = (r: { content: Array<{ text: string }> }) => r.content[0].text

beforeEach(() => {
  for (const m of [mockDoc.findUnique, mockWorkspace.findUnique, updateDocument, getCanvasOverview, layoutTreeCards]) m.mockReset()
  mockWorkspace.findUnique.mockResolvedValue({ thinkingModel: null, thinkingModelLabels: null })
  getCanvasOverview.mockResolvedValue(overview)
  layoutTreeCards.mockResolvedValue(new Map())
  updateDocument.mockResolvedValue(saved)
})

describe("buildCanvasTree", () => {
  it("draws the tree into an empty canvas", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    const r = await buildCanvasTree({ docId: "d1" })
    expect(r.structuredContent.ok).toBe(true)
    expect(r.structuredContent.data).toMatchObject({ addedCards: 3, addedGroups: 1, revision: "r2" })
    const canvas = JSON.parse(updateDocument.mock.calls[0][1].content)
    expect(canvas.nodes.filter((n: { type: string }) => n.type === "link")).toHaveLength(3)
    expect(canvas.edges.length).toBeGreaterThan(0)
  })

  it("is idempotent: a second build adds nothing and does not write", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    await buildCanvasTree({ docId: "d1" })
    const built = updateDocument.mock.calls[0][1].content
    updateDocument.mockClear()
    mockDoc.findUnique.mockResolvedValue(row(built, { revision: "r2" }))
    const again = await buildCanvasTree({ docId: "d1" })
    expect(message(again)).toMatch(/already on this canvas/)
    expect(updateDocument).not.toHaveBeenCalled()
  })

  it("falls back when layout throws", async () => {
    layoutTreeCards.mockRejectedValue(new Error("elk down"))
    mockDoc.findUnique.mockResolvedValue(row())
    expect((await buildCanvasTree({ docId: "d1" })).structuredContent.ok).toBe(true)
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it("scopes to a subtree", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    const r = await buildCanvasTree({ docId: "d1", scope: { kind: "opportunity", id: OPP1 } })
    expect(r.structuredContent.data).toMatchObject({ addedCards: 1 })
  })

  it("rejects a bad scope, non-canvas docs and missing docs", async () => {
    mockDoc.findUnique.mockResolvedValue(row())
    expect((await buildCanvasTree({ docId: "d1", scope: { kind: "opportunity", id: "nope" } })).structuredContent.ok).toBe(false)
    mockDoc.findUnique.mockResolvedValue(row("x", { docType: "DOC" }))
    expect((await buildCanvasTree({ docId: "d1" })).structuredContent.ok).toBe(false)
    mockDoc.findUnique.mockResolvedValue(null)
    expect((await buildCanvasTree({ docId: "d1" })).structuredContent.ok).toBe(false)
    expect(updateDocument).not.toHaveBeenCalled()
  })

  it("reports an empty workspace without writing", async () => {
    getCanvasOverview.mockResolvedValue({ ...overview, objectives: [], keyResults: [], opportunities: [] })
    mockDoc.findUnique.mockResolvedValue(row())
    expect(message(await buildCanvasTree({ docId: "d1" }))).toMatch(/nothing in this workspace/i)
    expect(updateDocument).not.toHaveBeenCalled()
  })
})
