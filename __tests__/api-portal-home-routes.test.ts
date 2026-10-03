/**
 * Authorization and validation for the Portal Home admin routes
 * (app/api/portal-home/[orgSlug]/[workspaceSlug]/**). Every handler must run
 * behind resolveWorkspaceAdmin, and writes must be Zod-validated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PermissionError } from "@/lib/permissions"
import { createWidget } from "@/lib/portal-home/schema"

const WS = "11111111-1111-4111-8111-111111111111"
const resolveWorkspaceAdmin = vi.fn()
const authMock = vi.fn()
const layouts = new Map<string, { draftWidgets: unknown; publishedWidgets: unknown; publishedAt: Date | null }>()

const prisma = {
  workspace: { findUnique: vi.fn(async () => ({ id: WS, roadmapPublic: true, feedbackEnabled: true })) },
  portalHomeLayout: {
    findUnique: vi.fn(async () => layouts.get(WS) ?? null),
    upsert: vi.fn(async ({ create, update }: { create: { draftWidgets: unknown }; update: { draftWidgets: unknown } }) => {
      const existing = layouts.get(WS)
      layouts.set(WS, { publishedWidgets: null, publishedAt: null, ...existing, draftWidgets: (existing ? update : create).draftWidgets })
    }),
    update: vi.fn(async ({ data }: { data: { publishedWidgets: unknown; publishedAt: Date } }) => {
      layouts.set(WS, { ...layouts.get(WS)!, publishedWidgets: data.publishedWidgets, publishedAt: data.publishedAt })
    }),
  },
  roadmapItem: { findMany: vi.fn(async () => []) },
  doc: { findMany: vi.fn(async () => []) },
}

vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  resolveWorkspaceAdmin: (...args: unknown[]) => resolveWorkspaceAdmin(...args),
}))
vi.mock("@/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))

const route = { params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "main" }) }
const json = (body: unknown) => new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => {
  layouts.clear()
  vi.clearAllMocks()
  resolveWorkspaceAdmin.mockResolvedValue({ workspaceId: WS, organizationId: "o" })
  authMock.mockResolvedValue({ user: { id: "user-1" } })
})

describe("authorization", () => {
  it.each([
    ["Unauthorized", 401],
    ["Workspace not found", 404],
    ["Forbidden: workspace admin required", 403],
  ])("maps %s to %i on every route and touches no data", async (message, status) => {
    resolveWorkspaceAdmin.mockRejectedValue(new PermissionError(message))
    const root = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/route")
    const publish = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/publish/route")
    const resolve = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/resolve/route")
    const options = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/options/route")
    const responses = await Promise.all([
      root.GET(new Request("http://x"), route),
      root.PUT(json({ widgets: [] }), route),
      publish.POST(json({}), route),
      resolve.POST(json({ widgets: [], audience: "member" }), route),
      options.GET(new Request("http://x"), route),
    ])
    expect(responses.map((r) => r.status)).toEqual([status, status, status, status, status])
    expect(prisma.portalHomeLayout.upsert).not.toHaveBeenCalled()
    expect(prisma.portalHomeLayout.update).not.toHaveBeenCalled()
    expect(prisma.roadmapItem.findMany).not.toHaveBeenCalled()
  })
})

describe("draft and publish", () => {
  it("rejects an invalid draft (unsafe url) with 400 and stores nothing", async () => {
    const { PUT } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/route")
    const bad = createWidget("announcement", 0)
    if (bad.type !== "announcement") throw new Error("unreachable")
    bad.config.primaryCta = { label: "Go", url: "javascript:alert(1)" }
    const response = await PUT(json({ widgets: [bad] }), route)
    expect(response.status).toBe(400)
    expect(layouts.size).toBe(0)
  })

  it("saves a draft without publishing it, then publishes it", async () => {
    const { GET, PUT } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/route")
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/publish/route")
    const widget = createWidget("rich_text", 7)

    const saved = await PUT(json({ widgets: [widget] }), route)
    expect(saved.status).toBe(200)
    expect(layouts.get(WS)?.publishedWidgets).toBeNull()
    expect(((await saved.json()) as { draft: { order: number }[] }).draft[0].order).toBe(0)

    const before = (await (await GET(new Request("http://x"), route)).json()) as { hasUnpublishedChanges: boolean; published: unknown }
    expect(before).toMatchObject({ hasUnpublishedChanges: true, published: null })

    const published = await POST(json({}), route)
    expect(published.status).toBe(200)
    expect(layouts.get(WS)?.publishedWidgets).toEqual(layouts.get(WS)?.draftWidgets)
    expect(layouts.get(WS)?.publishedAt).toBeInstanceOf(Date)
  })

  it("returns 409 when publishing with no draft", async () => {
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/publish/route")
    expect((await POST(json({}), route)).status).toBe(409)
  })

  it("never publishes a corrupted stored draft", async () => {
    layouts.set(WS, { draftWidgets: [{ type: "announcement", id: "x" }], publishedWidgets: null, publishedAt: null })
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/publish/route")
    expect((await POST(json({}), route)).status).toBe(400)
    expect(layouts.get(WS)?.publishedWidgets).toBeNull()
  })

  it("rejects malformed JSON with 400", async () => {
    const { PUT } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/route")
    const response = await PUT(new Request("http://x", { method: "PUT", body: "{nope" }), route)
    expect(response.status).toBe(400)
  })
})

describe("resolve", () => {
  it("customer audience hides signed_in widgets for a signed-out preview", async () => {
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/resolve/route")
    const visible = createWidget("announcement", 0)
    const gated = { ...createWidget("rich_text", 1), visibility: "signed_in" as const, config: { title: "Members", body: "Hi" } }
    const response = await POST(json({ widgets: [visible, gated], audience: "customer" }), route)
    const body = (await response.json()) as { widgets: { id: string }[] }
    expect(body.widgets.map((w) => w.id)).toEqual([visible.id])
  })

  it("customer audience never returns a team-only widget, signed in or not", async () => {
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/resolve/route")
    const visible = createWidget("announcement", 0)
    const team = { ...createWidget("rich_text", 1), visibility: "team" as const, config: { title: "TEAMONLY", body: "TEAMONLY" } }
    for (const signedIn of [false, true]) {
      const response = await POST(json({ widgets: [visible, team], audience: "customer", signedIn }), route)
      const text = await response.text()
      expect(text).not.toContain("TEAMONLY")
      expect(text).not.toContain(team.id)
    }
  })
})
