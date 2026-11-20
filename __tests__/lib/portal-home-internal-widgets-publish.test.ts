/**
 * Publish and rollback coverage for the team-only artifact_gallery / okr_summary widgets.
 * Runs the REAL service functions (saveDraft, publishDraft, loadPublishedHome) against an in-memory
 * portalHomeLayout row, then the REAL customer and team resolvers, so a publish of internal widgets
 * is followed all the way to what a customer would be sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import type { AppPrismaClient } from "@/lib/db"
import { resolveCustomerAvailability, resolveHomeForCustomer, resolveHomeForTeam } from "@/lib/portal-home/resolve"
import { createWidget, hasUnpublishedChanges, parseStoredWidgets, type PortalHomeWidget } from "@/lib/portal-home/schema"
import { loadHomeLayout, loadPublishedHome, publishDraft, saveDraft } from "@/lib/portal-home/service"

const WS = "11111111-1111-4111-8111-111111111111"
const ART = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OBJ = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const CYCLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const SECRET_ARTIFACT = "SECRET internal prototype"
const SECRET_OBJECTIVE = "SECRET internal objective"

type Row = { draftWidgets: unknown; publishedWidgets: unknown; publishedAt: Date | null; draftTemplate: string | null; publishedTemplate: string | null }
let row: Row | null

const artifactFindMany = vi.fn(async () => [
  { id: ART, title: SECRET_ARTIFACT, kind: null, sourceType: "HTML_UPLOAD", updatedAt: new Date(Date.UTC(2026, 8, 1)), currentRevisionId: null, currentRevision: null },
])
const objectiveFindMany = vi.fn(async () => [{ id: OBJ, title: SECRET_OBJECTIVE, status: "ON_TRACK", cycle: { title: "Q4" }, keyResults: [{ target: 10, current: 5 }] }])
const cycleFindFirst = vi.fn(async () => ({ id: CYCLE, title: "Q4" }))
const roadmapFindMany = vi.fn(async () => [])

const prisma = {
  portalHomeLayout: {
    findUnique: vi.fn(async () => (row ? { ...row } : null)),
    upsert: vi.fn(async ({ create, update }: { create: Partial<Row>; update: Partial<Row> }) => {
      row = row
        ? { ...row, ...update }
        : { publishedWidgets: null, publishedAt: null, draftTemplate: null, publishedTemplate: null, draftWidgets: [], ...create }
    }),
    update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      row = { ...row!, ...data }
    }),
  },
  artifact: { findMany: artifactFindMany },
  objective: { findMany: objectiveFindMany },
  oKRCycle: { findFirst: cycleFindFirst },
  roadmapItem: { findMany: roadmapFindMany },
  doc: { findMany: vi.fn(async () => []) },
} as unknown as AppPrismaClient

const ctx = { prisma, workspace: { id: WS, orgSlug: "acme", workspaceSlug: "main", roadmapPublic: true, feedbackEnabled: true } }

type GalleryWidget = Extract<PortalHomeWidget, { type: "artifact_gallery" }>
type OkrWidget = Extract<PortalHomeWidget, { type: "okr_summary" }>
const gallery = (order: number): GalleryWidget => {
  const base = createWidget("artifact_gallery", order) as GalleryWidget
  return { ...base, config: { ...base.config, mode: "selected", artifactIds: [ART] } }
}
const okr = (order: number): OkrWidget => {
  const base = createWidget("okr_summary", order) as OkrWidget
  return { ...base, config: { ...base.config, mode: "selected", cycleId: CYCLE, objectiveIds: [OBJ] } }
}
const richText = (order: number) => {
  const base = createWidget("rich_text", order)
  if (base.type !== "rich_text") throw new Error("unreachable")
  return { ...base, config: { ...base.config, title: "Public welcome", body: "Hello customers" } }
}

beforeEach(() => {
  row = null
  vi.clearAllMocks()
})

describe("publishing internal widgets", () => {
  it("round-trips the picker fields through save, publish and the customer read", async () => {
    await saveDraft(prisma, WS, [gallery(0), okr(1)])
    const published = await publishDraft(prisma, WS, "user-1")
    expect(published.published.map((w) => w.type)).toEqual(["artifact_gallery", "okr_summary"])

    const { widgets } = await loadPublishedHome(prisma, WS)
    const stored = widgets ?? []
    expect(stored.map((w) => w.type)).toEqual(["artifact_gallery", "okr_summary"])
    expect((stored[0] as GalleryWidget).config).toMatchObject({ mode: "selected", artifactIds: [ART] })
    expect((stored[1] as OkrWidget).config).toMatchObject({ mode: "selected", cycleId: CYCLE, objectiveIds: [OBJ] })
  })

  it("a published layout mixing public and internal widgets sends customers only the public ones, with no internal data or ids", async () => {
    await saveDraft(prisma, WS, [richText(0), gallery(1), okr(2)])
    await publishDraft(prisma, WS, "user-1")
    const { widgets } = await loadPublishedHome(prisma, WS)

    const home = await resolveHomeForCustomer(ctx, widgets ?? [], { signedIn: true })
    expect(home.widgets.map((w) => w.type)).toEqual(["rich_text"])
    const payload = JSON.stringify(home)
    for (const secret of [SECRET_ARTIFACT, SECRET_OBJECTIVE, ART, OBJ, CYCLE, "artifact_gallery", "okr_summary"]) expect(payload).not.toContain(secret)
    expect(artifactFindMany).not.toHaveBeenCalled()
    expect(objectiveFindMany).not.toHaveBeenCalled()
    expect(cycleFindFirst).not.toHaveBeenCalled()
  })

  it("a published layout of ONLY internal widgets leaves customers with nothing (the portal page shows its empty state), while the team still sees both", async () => {
    await saveDraft(prisma, WS, [gallery(0), okr(1)])
    await publishDraft(prisma, WS, "user-1")
    const { widgets } = await loadPublishedHome(prisma, WS)
    expect((await resolveHomeForCustomer(ctx, widgets ?? [], { signedIn: true })).widgets).toEqual([])

    const team = await resolveHomeForTeam(ctx, widgets ?? [])
    expect(team.widgets.map((w) => w.type)).toEqual(["artifact_gallery", "okr_summary"])
    expect(JSON.stringify(team.resolved)).toContain(SECRET_ARTIFACT)
  })

  it("the editor tells the admin each internal widget will NOT reach customers, and why", async () => {
    const availability = await resolveCustomerAvailability(ctx, [gallery(0), okr(1)])
    const verdicts = Object.values(availability)
    expect(verdicts).toHaveLength(2)
    for (const verdict of verdicts) {
      expect(verdict.shown).toBe(false)
      expect(verdict.shown === false && verdict.reason).toMatch(/internal/i)
    }
  })

  it("a stored draft with a corrupted internal widget fails publish strictly and leaves the published layout untouched", async () => {
    await saveDraft(prisma, WS, [richText(0)])
    await publishDraft(prisma, WS, "user-1")
    const before = structuredClone(row!.publishedWidgets)
    const publishedAt = row!.publishedAt

    row!.draftWidgets = [richText(0), { ...gallery(1), config: { ...gallery(1).config, artifactIds: ["not-a-uuid"] } }]
    await expect(publishDraft(prisma, WS, "user-1")).rejects.toBeInstanceOf(ZodError)
    expect(row!.publishedWidgets).toEqual(before)
    expect(row!.publishedAt).toBe(publishedAt)
  })
})

describe("rolling back internal widgets", () => {
  it("removing the widgets from the draft and republishing takes them out of the published layout and the team home", async () => {
    await saveDraft(prisma, WS, [richText(0), gallery(1), okr(2)])
    await publishDraft(prisma, WS, "user-1")

    await saveDraft(prisma, WS, [richText(0)])
    const layout = await loadHomeLayout(prisma, WS)
    expect(hasUnpublishedChanges(layout.draft, layout.published)).toBe(true)
    await publishDraft(prisma, WS, "user-1")

    const { widgets } = await loadPublishedHome(prisma, WS)
    expect((widgets ?? []).map((w) => w.type)).toEqual(["rich_text"])
    expect(JSON.stringify(row!.publishedWidgets)).not.toContain(ART)
    expect((await resolveHomeForTeam(ctx, widgets ?? [])).widgets.map((w) => w.type)).toEqual(["rich_text"])
    const after = await loadHomeLayout(prisma, WS)
    expect(hasUnpublishedChanges(after.draft, after.published)).toBe(false)
  })

  it("a code rollback is safe for what is already stored: a build that does not know a widget type drops it on read and keeps the rest", () => {
    // Stand-in for the older build's lenient read: a stored widget whose type it has no schema for.
    const unknownToOlderBuild = { id: "w_future", type: "future_widget", size: "M", order: 5, visibility: "everyone", config: {} }
    const stored = [richText(0), gallery(1), unknownToOlderBuild, okr(2)]
    const parsed = parseStoredWidgets(stored)
    expect(parsed.map((w) => w.type)).toEqual(["rich_text", "artifact_gallery", "okr_summary"])
    // An internal widget whose config no longer validates is dropped alone; the page does not fail.
    const bad = { ...gallery(3), config: { ...gallery(3).config, maxItems: 999 } }
    expect(parseStoredWidgets([richText(0), bad]).map((w) => w.type)).toEqual(["rich_text"])
  })

  it("republishing after a revert of only the draft (rollback to the previously published layout) restores exactly that layout", async () => {
    await saveDraft(prisma, WS, [richText(0)])
    await publishDraft(prisma, WS, "user-1")
    const previouslyPublished = structuredClone(row!.publishedWidgets)

    await saveDraft(prisma, WS, [richText(0), gallery(1), okr(2)])
    await publishDraft(prisma, WS, "user-1")
    expect(row!.publishedWidgets).not.toEqual(previouslyPublished)

    const layout = await loadHomeLayout(prisma, WS)
    await saveDraft(prisma, WS, previouslyPublished)
    await publishDraft(prisma, WS, "user-1")
    expect(layout.published?.length).toBe(3)
    expect(row!.publishedWidgets).toEqual(previouslyPublished)
  })
})
