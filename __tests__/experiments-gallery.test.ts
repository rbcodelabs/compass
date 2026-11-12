import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  EXPERIMENT_GALLERY_GROUP_MODES,
  groupExperimentGalleryItems,
  parseExperimentGalleryGroupMode,
  parseExperimentsView,
  type ExperimentGalleryItem,
} from "@/lib/experiments/gallery"
import { loadExperimentGalleryExtras } from "@/lib/experiments/gallery-server"
import { MAX_GALLERY_ARTIFACTS_PER_ITEM } from "@/lib/gallery/artifacts"

// The experiment-artifact link read goes through the entity_links readers; stub it at that seam.
const links = vi.hoisted(() => ({ readEntityLinksArtifactExperiment: vi.fn() }))
vi.mock("@/lib/links/readers", () => ({ readEntityLinksArtifactExperiment: links.readEntityLinksArtifactExperiment }))

const item = (id: string, over: Partial<ExperimentGalleryItem> = {}): ExperimentGalleryItem => ({
  id, title: id, hypothesis: `h-${id}`, status: "DESIGNING", conclusion: null, squad: null, ...over,
})
const squads = [{ id: "s1", name: "Growth", color: "#111" }, { id: "s2", name: "Platform", color: "#222" }]

describe("parseExperimentsView", () => {
  it("is gallery only for ?view=gallery; everything else is the board", () => {
    expect(parseExperimentsView("gallery")).toBe("gallery")
    expect(parseExperimentsView(undefined)).toBe("board")
    expect(parseExperimentsView("board")).toBe("board")
    expect(parseExperimentsView("kanban")).toBe("board")
    expect(parseExperimentsView(["gallery", "x"])).toBe("board")
  })
})

describe("parseExperimentGalleryGroupMode", () => {
  it("defaults to status and accepts only the known modes", () => {
    expect(parseExperimentGalleryGroupMode(undefined)).toBe("status")
    expect(parseExperimentGalleryGroupMode("nonsense")).toBe("status")
    for (const mode of EXPERIMENT_GALLERY_GROUP_MODES) expect(parseExperimentGalleryGroupMode(mode)).toBe(mode)
    expect([...EXPERIMENT_GALLERY_GROUP_MODES]).toEqual(["status", "squad", "conclusion", "none"])
  })
})

describe("groupExperimentGalleryItems", () => {
  const items = [
    item("a", { status: "KILLED", conclusion: "KILL", squad: squads[1] }),
    item("b", { status: "RUNNING", squad: squads[0] }),
    item("c", { status: "DESIGNING" }),
    item("d", { status: "COMPLETE", conclusion: "PROCEED", squad: squads[0] }),
    item("e", { status: "COMPLETE", conclusion: "ITERATE" }),
  ]

  it("groups by status in the board's column order with the board's labels", () => {
    const groups = groupExperimentGalleryItems(items, "status", { squads })
    expect(groups.map((g) => [g.key, g.label, g.items.map((i) => i.id)])).toEqual([
      ["DESIGNING", "Designing", ["c"]],
      ["RUNNING", "Running", ["b"]],
      ["COMPLETE", "Complete", ["d", "e"]],
      ["KILLED", "Killed", ["a"]],
    ])
  })
  it("drops empty groups and keeps an unknown status after the known ones", () => {
    const groups = groupExperimentGalleryItems([item("x", { status: "NOT_PURSUED" }), item("y", { status: "RUNNING" })], "status", { squads })
    expect(groups.map((g) => g.label)).toEqual(["Running", "Not Pursued"])
  })
  it("groups by squad in squad order with a colour and a No squad bucket last", () => {
    const groups = groupExperimentGalleryItems(items, "squad", { squads })
    expect(groups.map((g) => g.label)).toEqual(["Growth", "Platform", "No squad"])
    expect(groups[0]).toMatchObject({ color: "#111" })
    expect(groups[2].items.map((i) => i.id)).toEqual(["c", "e"])
  })
  it("groups by conclusion (Proceed, Iterate, Kill, Not pursued) with No conclusion last", () => {
    const groups = groupExperimentGalleryItems([...items, item("f", { conclusion: "NOT_PURSUED" })], "conclusion", { squads })
    expect(groups.map((g) => g.label)).toEqual(["Proceed", "Iterate", "Kill", "Not Pursued", "No conclusion"])
    expect(groups[4].items.map((i) => i.id)).toEqual(["b", "c"])
  })
  it("renders one flat group for none and nothing when empty", () => {
    expect(groupExperimentGalleryItems(items, "none", { squads })).toEqual([{ key: "all", label: "All experiments", color: null, items }])
    expect(groupExperimentGalleryItems([], "none", { squads })).toEqual([])
    expect(groupExperimentGalleryItems([], "status", { squads })).toEqual([])
  })
  it("keeps the input order inside a group", () => {
    const groups = groupExperimentGalleryItems([item("z"), item("m"), item("a")], "status", { squads })
    expect(groups[0].items.map((i) => i.id)).toEqual(["z", "m", "a"])
  })
})

describe("loadExperimentGalleryExtras", () => {
  const WS = "ws"
  const rev = (id: string, thumb: boolean) => ({ id, thumbnailPathname: thumb ? "p" : null, thumbnailWidth: thumb ? 800 : null, thumbnailHeight: thumb ? 500 : null, thumbnailCapturedAt: thumb ? new Date(5) : null })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  const link = (artifactId: string, experimentId: string) => ({ fromId: artifactId, toId: experimentId })
  beforeEach(() => {
    links.readEntityLinksArtifactExperiment.mockReset()
    links.readEntityLinksArtifactExperiment.mockResolvedValue([link("a1", "e1"), link("a2", "e1"), link("a1", "e1"), link("a3", "e2")])
    db = {
      artifact: { findMany: vi.fn(async () => [
        { id: "a2", title: "Newer", sourceType: "EXTERNAL_LINK", kind: null, currentRevision: rev("r2", false) },
        { id: "a1", title: "Older", sourceType: "HTML_UPLOAD", kind: "SLIDE_DECK", currentRevision: rev("r1", true) },
        { id: "a3", title: "Chat", sourceType: "V0_CHAT", kind: null, currentRevision: null },
      ]) },
    }
  })

  it("batches: one link read and one artifact query for any number of experiments", async () => {
    await loadExperimentGalleryExtras(db, WS, ["e1", "e2", "e3"])
    expect(links.readEntityLinksArtifactExperiment).toHaveBeenCalledTimes(1)
    expect(db.artifact.findMany).toHaveBeenCalledTimes(1)
    expect(links.readEntityLinksArtifactExperiment.mock.calls[0][1]).toBe(WS)
    expect(db.artifact.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, status: "ACTIVE" })
  })
  it("returns newest-first, de-duplicated artifacts with thumbnails per experiment", async () => {
    const out = await loadExperimentGalleryExtras(db, WS, ["e1", "e2"])
    expect(out.e1.artifacts.map((a) => a.id)).toEqual(["a2", "a1"])
    expect(out.e1.artifacts[1].thumbnail?.src).toBe("/api/artifacts/a1/revisions/r1/thumbnail?v=5")
    expect(out.e1.artifacts[1].kind).toBe("SLIDE_DECK")
    expect(out.e2.artifacts[0]).toMatchObject({ id: "a3", capturable: false })
  })
  it("gives experiments with no artifact an empty set, and makes no queries for an empty id list", async () => {
    const out = await loadExperimentGalleryExtras(db, WS, ["e1", "e9"])
    expect(out.e9).toEqual({ artifacts: [], moreArtifacts: 0 })
    links.readEntityLinksArtifactExperiment.mockClear()
    db.artifact.findMany.mockClear()
    expect(await loadExperimentGalleryExtras(db, WS, [])).toEqual({})
    expect(links.readEntityLinksArtifactExperiment).not.toHaveBeenCalled()
    expect(db.artifact.findMany).not.toHaveBeenCalled()
  })
  it("skips the artifact query when no experiment has any link", async () => {
    links.readEntityLinksArtifactExperiment.mockResolvedValue([])
    const out = await loadExperimentGalleryExtras(db, WS, ["e1"])
    expect(db.artifact.findMany).not.toHaveBeenCalled()
    expect(out.e1).toEqual({ artifacts: [], moreArtifacts: 0 })
  })
  it("drops artifacts the ACTIVE query filtered out (archived) from the card", async () => {
    db.artifact.findMany = vi.fn(async () => [{ id: "a1", title: "Live", sourceType: "HTML_UPLOAD", kind: null, currentRevision: null }])
    const out = await loadExperimentGalleryExtras(db, WS, ["e1"])
    expect(out.e1.artifacts.map((a) => a.id)).toEqual(["a1"])
  })
  it("caps artifacts per experiment and reports the remainder", async () => {
    const many = Array.from({ length: MAX_GALLERY_ARTIFACTS_PER_ITEM + 2 }, (_, i) => `x${i}`)
    links.readEntityLinksArtifactExperiment.mockResolvedValue(many.map((id) => link(id, "e1")))
    db.artifact.findMany = vi.fn(async () => many.map((id) => ({ id, title: id, sourceType: "HTML_UPLOAD", kind: null, currentRevision: null })))
    const out = await loadExperimentGalleryExtras(db, WS, ["e1"])
    expect(out.e1.artifacts).toHaveLength(MAX_GALLERY_ARTIFACTS_PER_ITEM)
    expect(out.e1.moreArtifacts).toBe(2)
  })
})
