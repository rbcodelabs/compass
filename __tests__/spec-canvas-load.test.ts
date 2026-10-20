import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  opportunityFindFirst: vi.fn(),
  keyResultFindFirst: vi.fn(),
  keyResultFindMany: vi.fn(),
  objectiveFindMany: vi.fn(),
  artifactLinkFindMany: vi.fn(),
  artifactFindMany: vi.fn(),
  linkedObjectives: vi.fn(),
  linkedKeyResults: vi.fn(),
  storageGet: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  default: () => ({
    opportunity: { findFirst: m.opportunityFindFirst },
    keyResult: { findFirst: m.keyResultFindFirst, findMany: m.keyResultFindMany },
    objective: { findMany: m.objectiveFindMany },
    artifactLink: { findMany: m.artifactLinkFindMany },
    artifact: { findMany: m.artifactFindMany },
  }),
}))
vi.mock("@/lib/typed-links", () => ({ getLinkedObjectivesByOpportunity: m.linkedObjectives, getLinkedKeyResultsBySolution: m.linkedKeyResults }))
vi.mock("@/lib/artifact-storage", () => ({ getArtifactStorage: () => ({ get: m.storageGet }) }))
import { loadSpecCanvas, MAX_INLINE_PROTOTYPE_FRAMES } from "@/lib/spec-canvas/load"

const args = { workspaceId: "ws-1", opportunityId: "opp-1", orgSlug: "acme", workspaceSlug: "growth" }
const opportunity = (solutionIds: string[], linkedKeyResultId: string | null = null) => ({
  id: "opp-1", title: "T", description: null, status: "EXPLORING", customerSegment: null, linkedKeyResultId, seqPrefix: "OPP", seqNumber: 1,
  evidence: [],
  solutions: solutionIds.map((id) => ({ id, title: `Sol ${id}`, description: null, status: "IDEA", seqPrefix: null, seqNumber: null, assumptions: [] })),
})
const artifactRow = (id: string, blobPathname: string | null) => ({
  id, title: id, description: null, sourceType: "HTML_UPLOAD", kind: null, seqPrefix: null, seqNumber: null,
  currentRevision: { id: `rev-${id}`, externalUrl: null, blobPathname, thumbnailPathname: null, thumbnailWidth: null, thumbnailHeight: null, thumbnailCapturedAt: null },
})

beforeEach(() => {
  vi.resetAllMocks()
  m.linkedObjectives.mockResolvedValue(new Map())
  m.linkedKeyResults.mockResolvedValue(new Map())
  m.keyResultFindMany.mockResolvedValue([])
  m.objectiveFindMany.mockResolvedValue([])
  m.artifactLinkFindMany.mockResolvedValue([])
  m.artifactFindMany.mockResolvedValue([])
})

describe("loadSpecCanvas", () => {
  it("returns null when the opportunity is not in the workspace, and queries nothing else", async () => {
    m.opportunityFindFirst.mockResolvedValue(null)
    expect(await loadSpecCanvas(args)).toBeNull()
    expect(m.opportunityFindFirst.mock.calls[0][0].where).toEqual({ id: "opp-1", workspaceId: "ws-1" })
    expect(m.linkedObjectives).not.toHaveBeenCalled()
    expect(m.objectiveFindMany).not.toHaveBeenCalled()
  })

  it("scopes every follow-up query to the workspace", async () => {
    m.opportunityFindFirst.mockResolvedValue(opportunity(["s1"], "kr-legacy"))
    const legacy = { id: "kr-legacy", title: "L", current: 1, target: 2, unit: null, objectiveId: "obj-1", seqPrefix: null, seqNumber: null }
    m.keyResultFindFirst.mockResolvedValue(legacy)
    m.linkedObjectives.mockResolvedValue(new Map([["opp-1", [{ id: "obj-2", title: "O2" }]]]))
    m.linkedKeyResults.mockResolvedValue(new Map([["s1", [{ id: "kr-s", title: "S", objectiveId: "obj-3" }]]]))
    m.keyResultFindMany.mockResolvedValue([{ id: "kr-s", title: "S", current: 0, target: 4, unit: null, objectiveId: "obj-3", seqPrefix: null, seqNumber: null }])
    m.artifactLinkFindMany.mockResolvedValue([{ artifactId: "a1", linkedId: "s1" }])
    m.artifactFindMany.mockResolvedValue([artifactRow("a1", null)])
    m.objectiveFindMany.mockResolvedValue([
      { id: "obj-1", title: "O1", description: null, status: "ON_TRACK", seqPrefix: null, seqNumber: null },
      { id: "obj-3", title: "O3", description: null, status: "ON_TRACK", seqPrefix: null, seqNumber: null },
    ])

    const spec = await loadSpecCanvas(args)

    expect(m.keyResultFindFirst.mock.calls[0][0].where).toEqual({ id: "kr-legacy", objective: { workspaceId: "ws-1" } })
    expect(m.keyResultFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["kr-s"] }, objective: { workspaceId: "ws-1" } })
    expect(m.objectiveFindMany.mock.calls[0][0].where).toEqual({ id: { in: ["obj-2", "obj-1", "obj-3"] }, workspaceId: "ws-1" })
    expect(m.artifactLinkFindMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1", linkedType: "SOLUTION" })
    expect(m.artifactFindMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1", status: "ACTIVE" })
    // Only objectives the workspace returned are shown (obj-2 was filtered out as foreign/NULL).
    expect(spec?.objectives.map((o) => o.id)).toEqual(["obj-1", "obj-3"])
    expect(spec?.objectives[0].keyResults[0].linkedVia.opportunity).toBe(true)
    expect(spec?.objectives[1].keyResults[0].linkedVia.solutionTitles).toEqual(["Sol s1"])
    expect(spec?.artifacts.map((a) => a.id)).toEqual(["a1"])
  })

  it("frames at most the first few uploaded prototypes and survives a storage failure", async () => {
    const ids = ["a1", "a2", "a3", "a4", "a5"]
    m.opportunityFindFirst.mockResolvedValue(opportunity(["s1"]))
    m.artifactLinkFindMany.mockResolvedValue(ids.map((artifactId) => ({ artifactId, linkedId: "s1" })))
    m.artifactFindMany.mockResolvedValue(ids.map((id) => artifactRow(id, `blob/${id}`)))
    m.storageGet.mockImplementation(async (path: string) => {
      if (path === "blob/a1") throw new Error("storage down")
      return new TextEncoder().encode("<html><body>hi</body></html>")
    })

    const spec = await loadSpecCanvas(args)

    expect(spec?.artifacts.map((a) => Boolean(a.previewHtml))).toEqual([false, true, true, true, false])
    expect(spec?.artifacts.filter((a) => a.previewHtml)).toHaveLength(MAX_INLINE_PROTOTYPE_FRAMES)
  })
})
