import { describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { resolveHomeForCustomer, resolveHomeForTeam } from "@/lib/portal-home/resolve"
import { createWidget, parseStoredWidgets, widgetSchema, type PortalHomeWidget } from "@/lib/portal-home/schema"
import type { ArtifactGalleryConfig } from "@/lib/portal-home/widgets/artifact-gallery"
import type { OkrSummaryConfig } from "@/lib/portal-home/widgets/okr-summary"

const WS = "11111111-1111-4111-8111-111111111111"
const ctx = (prisma: unknown) => ({
  prisma: prisma as AppPrismaClient,
  workspace: { id: WS, orgSlug: "acme", workspaceSlug: "main", roadmapPublic: true, feedbackEnabled: true },
})

function fakePrisma() {
  return {
    artifact: {
      findMany: vi.fn(async () => [
        { id: "a1", title: "Prototype", kind: null, sourceType: "HTML_UPLOAD", updatedAt: new Date(Date.UTC(2026, 8, 1)), currentRevisionId: "r1", currentRevision: { artifactId: "a1", thumbnailPathname: "x" } },
        { id: "a2", title: "Deck", kind: "SLIDE_DECK", sourceType: "HTML_UPLOAD", updatedAt: new Date(Date.UTC(2026, 8, 2)), currentRevisionId: "r2", currentRevision: { artifactId: "other-artifact", thumbnailPathname: "x" } },
      ]),
    },
    oKRCycle: { findFirst: vi.fn(async () => ({ id: "c1", title: "Q4" })) },
    objective: {
      findMany: vi.fn(async () => [
        { id: "o1", title: "Grow", status: "ON_TRACK", cycle: { title: "Q4", workspaceId: WS }, keyResults: [{ target: 10, current: 5 }, { target: 100, current: 100 }] },
        { id: "o2", title: "Empty", status: "AT_RISK", cycle: null, keyResults: [] },
      ]),
    },
  }
}

type GalleryWidget = Extract<PortalHomeWidget, { type: "artifact_gallery" }>
type OkrWidget = Extract<PortalHomeWidget, { type: "okr_summary" }>
const galleryWidget = (config: Partial<ArtifactGalleryConfig>, order = 0): GalleryWidget => {
  const base = createWidget("artifact_gallery", order) as GalleryWidget
  return { ...base, config: { ...base.config, ...config } }
}
const okrWidget = (config: Partial<OkrSummaryConfig>, order = 1): OkrWidget => {
  const base = createWidget("okr_summary", order) as OkrWidget
  return { ...base, config: { ...base.config, ...config } }
}

const widgets = () => [createWidget("artifact_gallery", 0), createWidget("okr_summary", 1)]

describe("artifact gallery and OKR widgets", () => {
  it("never query or resolve for a customer, even when visible to everyone", async () => {
    const prisma = fakePrisma()
    const home = await resolveHomeForCustomer(ctx(prisma), widgets().map((widget) => ({ ...widget, visibility: "everyone" })), { signedIn: true })
    expect(home.widgets).toEqual([])
    expect(prisma.artifact.findMany).not.toHaveBeenCalled()
    expect(prisma.objective.findMany).not.toHaveBeenCalled()
    expect(prisma.oKRCycle.findFirst).not.toHaveBeenCalled()
  })

  it.each(["artifact_gallery", "okr_summary"] as const)("always treats %s as team-only, including stored drafts", (type) => {
    const widget = createWidget(type, 0)
    expect(widget.visibility).toBe("team")
    expect(widgetSchema.parse({ ...widget, visibility: "everyone" }).visibility).toBe("team")
  })

  it("uses shared progress math and keeps legacy key results without a workspace", async () => {
    const prisma = fakePrisma()
    prisma.objective.findMany.mockResolvedValueOnce([
      { id: "o1", title: "Reduce churn", status: "ON_TRACK", cycle: { title: "Other cycle", workspaceId: "other-workspace" }, keyResults: [{ current: -5, target: -10 }] },
    ])
    const widget = okrWidget({ mode: "selected", objectiveIds: ["o1"] })
    const home = await resolveHomeForTeam(ctx(prisma), [widget])
    expect(home.resolved[widget.id]).toMatchObject({ data: { objectives: [{ progress: 50, keyResultCount: 1, cycleTitle: null }] } })
    expect(prisma.objective.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        keyResults: { where: { OR: [{ workspaceId: WS }, { workspaceId: null }] }, select: { current: true, target: true } },
      }),
    }))
  })

  it("uses the newest active cycle, matching the OKRs index", async () => {
    const prisma = fakePrisma()
    await resolveHomeForTeam(ctx(prisma), [okrWidget({ mode: "active" })])
    expect(prisma.oKRCycle.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.oKRCycle.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, status: "ACTIVE" },
      orderBy: [{ startDate: "desc" }],
    }))
  })

  it("selected mode keeps the admin's order, drops missing ids, and scopes the query to the workspace", async () => {
    const prisma = fakePrisma()
    const gallery = galleryWidget({ title: "Picked", mode: "selected", artifactIds: ["a2", "gone", "a1"] })
    const okr = okrWidget({ title: "Picked", mode: "selected", objectiveIds: ["o2", "o1"] })
    const home = await resolveHomeForTeam(ctx(prisma), [gallery, okr])
    const [g, o] = home.widgets.map((w) => home.resolved[w.id])
    if (!g.available || g.data.type !== "artifact_gallery") throw new Error("expected gallery")
    expect(g.data.artifacts.map((a) => a.id)).toEqual(["a2", "a1"])
    expect(prisma.artifact.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, status: "ACTIVE", id: { in: ["a2", "gone", "a1"] } } }))
    if (!o.available || o.data.type !== "okr_summary") throw new Error("expected okr")
    expect(o.data.objectives.map((x) => x.id)).toEqual(["o2", "o1"])
    expect(prisma.objective.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, id: { in: ["o2", "o1"] } } }))
  })

  it("selected mode with nothing chosen is unavailable and runs no query", async () => {
    const prisma = fakePrisma()
    const gallery = galleryWidget({ title: "Empty", mode: "selected", artifactIds: [] })
    const okr = okrWidget({ title: "Empty", mode: "cycle", cycleId: null })
    const home = await resolveHomeForTeam(ctx(prisma), [gallery, okr])
    expect(home.widgets).toEqual([])
    expect(prisma.artifact.findMany).not.toHaveBeenCalled()
    expect(prisma.objective.findMany).not.toHaveBeenCalled()
  })

  it("cycle mode looks the cycle up in this workspace and is unavailable when it is missing or unset", async () => {
    const prisma = fakePrisma()
    const CYCLE = "33333333-3333-4333-8333-333333333333"
    const okr = okrWidget({ mode: "cycle", cycleId: CYCLE }, 0)
    const home = await resolveHomeForTeam(ctx(prisma), [okr])
    expect(home.widgets).toHaveLength(1)
    expect(prisma.oKRCycle.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, id: CYCLE } }))
    expect(prisma.objective.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WS, cycleId: "c1" } }))

    prisma.oKRCycle.findFirst.mockResolvedValueOnce(null as never)
    const gone = await resolveHomeForTeam(ctx(prisma), [okr])
    expect(gone.widgets).toEqual([])

    const unset = fakePrisma()
    const none = await resolveHomeForTeam(ctx(unset), [okrWidget({ mode: "cycle", cycleId: null }, 0)])
    expect(none.widgets).toEqual([])
    expect(unset.oKRCycle.findFirst).not.toHaveBeenCalled()
  })

  it("layouts saved before the picker fields existed still load, with the original behaviour", () => {
    const stored = [
      { id: "old-art", type: "artifact_gallery", size: "M", order: 0, visibility: "everyone", config: { title: "Artifacts", maxItems: 6 } },
      { id: "old-okr", type: "okr_summary", size: "M", order: 1, visibility: "everyone", config: { title: "OKRs", maxObjectives: 4 } },
    ]
    const widgets = parseStoredWidgets(stored)
    expect(widgets).toHaveLength(2)
    const [art, okr] = widgets
    expect(art.type === "artifact_gallery" && art.config).toMatchObject({ mode: "recent", artifactIds: [] })
    expect(okr.type === "okr_summary" && okr.config).toMatchObject({ mode: "active", cycleId: null, objectiveIds: [] })
  })

  it("widgets of every pre-existing type still parse alongside the new ones", () => {
    const existing = (["announcement", "key_links", "roadmap_spotlight", "recent_updates", "feedback_cta", "rich_text", "docs"] as const).map(
      (type, order) => createWidget(type, order),
    )
    const stored = JSON.parse(JSON.stringify([...existing, createWidget("artifact_gallery", 7)]))
    const parsed = parseStoredWidgets(stored)
    expect(parsed.map((w) => w.type)).toEqual([...existing.map((w) => w.type), "artifact_gallery"])
  })

  it("rejects non-UUID picks and an over-long selection", () => {
    const art = createWidget("artifact_gallery", 0)
    expect(widgetSchema.safeParse({ ...art, config: { ...art.config, artifactIds: ["not-a-uuid"] } }).success).toBe(false)
    expect(widgetSchema.safeParse({ ...art, config: { ...art.config, mode: "everything" } }).success).toBe(false)
    const ids = Array.from({ length: 13 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)
    expect(widgetSchema.safeParse({ ...art, config: { ...art.config, artifactIds: ids } }).success).toBe(false)
  })

  it("resolve for the team with thumbnails, hrefs and averaged KR progress", async () => {
    const home = await resolveHomeForTeam(ctx(fakePrisma()), widgets())
    const [gallery, okr] = home.widgets.map((w) => home.resolved[w.id])
    expect(gallery).toMatchObject({ available: true })
    if (!gallery.available || gallery.data.type !== "artifact_gallery") throw new Error("expected gallery")
    expect(gallery.data.artifacts[0].href).toBe("/acme/main/docs/artifacts/a1")
    expect(gallery.data.artifacts[0].thumbnailSrc).toBe("/api/artifacts/a1/revisions/r1/thumbnail")
    expect(gallery.data.artifacts[1].thumbnailSrc).toBeNull()
    if (!okr.available || okr.data.type !== "okr_summary") throw new Error("expected okr")
    expect(okr.data.cycleTitle).toBe("Q4")
    expect(okr.data.objectives.map((o) => o.progress)).toEqual([75, 0])
    expect(okr.data.okrsHref).toBe("/acme/main/okrs")
  })
})
