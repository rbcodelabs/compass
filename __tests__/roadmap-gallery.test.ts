import { beforeEach, describe, expect, it, vi } from "vitest"
import { groupGalleryItems, MAX_GALLERY_ARTIFACTS_PER_ITEM, type GalleryItemExtras } from "@/lib/roadmap/gallery"
import { loadRoadmapGalleryExtras } from "@/lib/roadmap/gallery-server"
import { parseGroupByParam, resolveRoadmapGroupBy } from "@/lib/roadmap-group-by"
import { DEFAULT_ROADMAP_DISPLAY } from "@/lib/roadmap-views/schema"
import { resolveWorkspaceRoadmapState, workspacePageParams, workspaceStateToParams } from "@/lib/roadmap-views/workspace"
import type { RoadmapCardData } from "@/components/roadmap/roadmap-card"

// The Solution -> Artifact link read goes through the entity_links readers; stub it at that seam.
const links = vi.hoisted(() => ({ readEntityLinksArtifact: vi.fn() }))
vi.mock("@/lib/links/readers", () => ({ readEntityLinksArtifact: links.readEntityLinksArtifact }))
const artifactLink = (artifactId: string, solutionId: string) => ({ linkType: "ARTIFACT_ATTACHED_TO_SOLUTION", fromType: "ARTIFACT", fromId: artifactId, toType: "SOLUTION", toId: solutionId })

const card = (id: string, over: Partial<RoadmapCardData> = {}): RoadmapCardData => ({
  id, title: id, description: null, horizon: "NOW", sortOrder: 0, isPrivate: false, solutionId: null, keyResultId: null, opportunityId: null,
  experimentId: null, feedbackId: null, startDate: null, endDate: null, updatedAt: "2026-01-01T00:00:00.000Z", solution: null, keyResult: null,
  opportunity: null, experiment: null, feedback: null, squad: null, launchChecklist: null, deliveryStatus: "NOT_STARTED", ...over,
})
const none: GalleryItemExtras = { solutionStatus: null, artifacts: [], moreArtifacts: 0 }

describe("groupGalleryItems", () => {
  const squads = [{ id: "s1", name: "Growth", color: "#111" }, { id: "s2", name: "Platform", color: "#222" }]
  const items = [card("a", { horizon: "LATER", squad: squads[1] }), card("b", { horizon: "NOW", squad: squads[0] }), card("c", { horizon: "NOW" })]
  const extras = { a: { ...none, solutionStatus: "SHIPPED" }, b: { ...none, solutionStatus: "IN_DELIVERY" }, c: none }

  it("groups by horizon in roadmap order and drops empty groups", () => {
    expect(groupGalleryItems(items, "horizon", { squads, extras }).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([["Now", ["b", "c"]], ["Later", ["a"]]])
  })
  it("groups by solution status, putting items without a solution last", () => {
    expect(groupGalleryItems(items, "status", { squads, extras }).map((g) => g.label)).toEqual(["In delivery", "Shipped", "No solution"])
  })
  it("groups by squad in squad order with a No squad bucket", () => {
    const groups = groupGalleryItems(items, "squad", { squads, extras })
    expect(groups.map((g) => g.label)).toEqual(["Growth", "Platform", "No squad"])
    expect(groups[0].color).toBe("#111")
  })
  it("renders one flat group for none, and nothing when empty", () => {
    expect(groupGalleryItems(items, "none", { squads, extras })).toHaveLength(1)
    expect(groupGalleryItems([], "none", { squads, extras })).toEqual([])
  })
  it("keeps an unknown status after the known ones", () => {
    const g = groupGalleryItems([card("x")], "status", { squads, extras: { x: { ...none, solutionStatus: "PAUSED" } } })
    expect(g.map((x) => x.label)).toEqual(["PAUSED"])
  })
})

describe("loadRoadmapGalleryExtras", () => {
  const WS = "ws"
  const rev = (id: string, thumb: boolean) => ({ id, thumbnailPathname: thumb ? "p" : null, thumbnailWidth: thumb ? 800 : null, thumbnailHeight: thumb ? 500 : null, thumbnailCapturedAt: thumb ? new Date(5) : null })
  // Hand-rolled partial Prisma transaction client: only the delegates the loader touches are stubbed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  beforeEach(() => {
    links.readEntityLinksArtifact.mockReset()
    links.readEntityLinksArtifact.mockResolvedValue([artifactLink("a1", "sol1"), artifactLink("a2", "sol1"), artifactLink("a1", "sol1"), artifactLink("a3", "sol2")])
    db = {
      solution: { findMany: vi.fn(async () => [{ id: "sol1", status: "IN_DELIVERY" }, { id: "sol2", status: "IDEA" }]) },
      artifact: { findMany: vi.fn(async () => [
        { id: "a2", title: "Newer", sourceType: "EXTERNAL_LINK", kind: null, currentRevision: rev("r2", false) },
        { id: "a1", title: "Older", sourceType: "HTML_UPLOAD", kind: "SLIDE_DECK", currentRevision: rev("r1", true) },
        { id: "a3", title: "Chat", sourceType: "V0_CHAT", kind: null, currentRevision: null },
      ]) },
    }
  })

  it("batches: one solution, one link and one artifact query regardless of item count", async () => {
    await loadRoadmapGalleryExtras(db, WS, [{ id: "i1", solutionId: "sol1" }, { id: "i2", solutionId: "sol2" }, { id: "i3", solutionId: "sol1" }])
    expect(db.solution.findMany).toHaveBeenCalledTimes(1)
    expect(links.readEntityLinksArtifact).toHaveBeenCalledTimes(1)
    expect(links.readEntityLinksArtifact).toHaveBeenCalledWith(db, WS, { solutionIds: ["sol1", "sol2"] })
    expect(db.artifact.findMany).toHaveBeenCalledTimes(1)
    expect(db.artifact.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, status: "ACTIVE" })
  })
  it("returns newest-first, de-duplicated artifacts with thumbnail DTOs and capturability", async () => {
    const out = await loadRoadmapGalleryExtras(db, WS, [{ id: "i1", solutionId: "sol1" }])
    expect(out.i1.solutionStatus).toBe("IN_DELIVERY")
    expect(out.i1.artifacts.map((a) => a.id)).toEqual(["a2", "a1"])
    expect(out.i1.artifacts[0]).toMatchObject({ thumbnail: null, capturable: true, kind: "DOCUMENT" })
    expect(out.i1.artifacts[1].thumbnail?.src).toBe("/api/artifacts/a1/revisions/r1/thumbnail?v=5")
    expect(out.i1.artifacts[1].kind).toBe("SLIDE_DECK")
  })
  it("marks v0 chats as not capturable and gives items without a solution empty extras without querying", async () => {
    const out = await loadRoadmapGalleryExtras(db, WS, [{ id: "i2", solutionId: "sol2" }, { id: "i9", solutionId: null }])
    expect(out.i2.artifacts[0].capturable).toBe(false)
    expect(out.i9).toEqual(none)
    db.solution.findMany.mockClear()
    await loadRoadmapGalleryExtras(db, WS, [{ id: "i9", solutionId: null }])
    expect(db.solution.findMany).not.toHaveBeenCalled()
  })
  it("caps artifacts per item and reports the remainder", async () => {
    const many = Array.from({ length: MAX_GALLERY_ARTIFACTS_PER_ITEM + 2 }, (_, i) => `x${i}`)
    links.readEntityLinksArtifact.mockResolvedValue(many.map((id) => artifactLink(id, "sol1")))
    db.artifact.findMany = vi.fn(async () => many.map((id) => ({ id, title: id, sourceType: "HTML_UPLOAD", kind: null, currentRevision: null })))
    const out = await loadRoadmapGalleryExtras(db, WS, [{ id: "i1", solutionId: "sol1" }])
    expect(out.i1.artifacts).toHaveLength(MAX_GALLERY_ARTIFACTS_PER_ITEM)
    expect(out.i1.moreArtifacts).toBe(2)
  })
})

describe("gallery URL state", () => {
  it("round-trips view=gallery and groupBy=status through saved-view state", () => {
    const s = resolveWorkspaceRoadmapState({ view: "gallery", groupBy: "status" }, null)
    expect(s.display).toMatchObject({ view: "gallery", groupBy: "status" })
    expect(workspaceStateToParams(s).toString()).toBe("groupBy=status&view=gallery")
    expect(workspacePageParams(s)).toMatchObject({ view: "gallery", groupBy: "status" })
  })
  it("still treats unknown views as board", () => {
    expect(resolveWorkspaceRoadmapState({ view: "kanban" }, null).display.view).toBe(DEFAULT_ROADMAP_DISPLAY.view)
  })
  it("parses status as its own group-by mode", () => {
    expect(resolveRoadmapGroupBy(parseGroupByParam("status"), [])).toEqual({ mode: "status" })
  })
})

describe("withoutGalleryOnlyDisplay", () => {
  it("maps gallery/status to the cross-workspace defaults and leaves other state alone", async () => {
    const { withoutGalleryOnlyDisplay } = await import("@/lib/roadmap-views/schema")
    const filters = {} as never
    expect(withoutGalleryOnlyDisplay({ filters, display: { ...DEFAULT_ROADMAP_DISPLAY, view: "gallery", groupBy: "status" } }).display).toMatchObject({ view: "board", groupBy: "horizon" })
    const same = { filters, display: { ...DEFAULT_ROADMAP_DISPLAY, view: "timeline" as const, groupBy: "squad" as const } }
    expect(withoutGalleryOnlyDisplay(same)).toBe(same)
  })
})
