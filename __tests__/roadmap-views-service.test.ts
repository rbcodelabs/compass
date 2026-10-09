import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getUserWorkspaces: vi.fn(), auth: vi.fn(), revalidatePath: vi.fn(), db: {} as Record<string, unknown> }))
vi.mock("@/lib/workspace", () => ({ getUserWorkspaces: mocks.getUserWorkspaces }))
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }))

import type { RoadmapViewActor } from "@/lib/roadmap-views/access"
import {
  MAX_VIEWS_PER_OWNER_PER_SURFACE, createRoadmapView, deleteRoadmapView, getRoadmapView, listRoadmapViews,
  resolveRoadmapViewActor, updateRoadmapView,
} from "@/lib/roadmap-views/service"
import { createRoadmapViewAction, deleteRoadmapViewAction, updateRoadmapViewAction } from "@/app/[orgSlug]/roadmap/actions"

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const WS_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const WS_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ME = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

type Row = {
  id: string; organizationId: string; workspaceId: string | null; ownerId: string; name: string
  visibility: string; filters: unknown; display: unknown; createdAt: Date; updatedAt: Date
}

/** Minimal in-memory stand-in for the prisma delegate; honours the where shapes the service uses. */
function makeStore(seed: Row[] = []) {
  const rows = [...seed]
  const match = (r: Row, w: Record<string, unknown>): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === "OR") return (v as Record<string, unknown>[]).some((c) => match(r, c))
      return (r as Record<string, unknown>)[k] === v
    })
  const roadmapView = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)).length,
    create: async ({ data }: { data: Omit<Row, "id"> }) => { const row = { id: randomUUID(), ...data }; rows.push(row); return row },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => match(r, where)); hit.forEach((r) => Object.assign(r, data)); return { count: hit.length }
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const hit = rows.filter((r) => match(r, where)); hit.forEach((r) => rows.splice(rows.indexOf(r), 1)); return { count: hit.length }
    },
  }
  return { rows, db: { roadmapView } as never }
}

const row = (over: Partial<Row>): Row => ({
  id: "seed", organizationId: ORG, workspaceId: null, ownerId: ME, name: "Seed", visibility: "PERSONAL",
  filters: {}, display: {}, createdAt: new Date(0), updatedAt: new Date(0), ...over,
})
const actor = (over: Partial<RoadmapViewActor> = {}): RoadmapViewActor => ({
  userId: ME, organizationId: ORG, isOrgAdmin: false, workspaces: [{ id: WS_A, isReadOnly: false, isAdmin: false }], ...over,
})
const input = (over: Record<string, unknown> = {}) => ({ name: "Mine", filters: {}, display: {}, ...over })

describe("resolveRoadmapViewActor", () => {
  const orgDb = (orgRole: string | null, wsRoles: Array<{ workspaceId: string; role: string }>, orgFound = true) => ({
    organization: { findUnique: async () => (orgFound ? { id: ORG } : null) },
    organizationMember: { findFirst: async () => (orgRole ? { role: orgRole } : null) },
    workspaceMember: { findMany: async () => wsRoles },
  }) as never

  it("returns null when the user reaches nothing in that org", async () => {
    mocks.getUserWorkspaces.mockResolvedValue([{ id: WS_B, orgSlug: "other", isReadOnly: false }])
    expect(await resolveRoadmapViewActor(ME, "acme", orgDb("MEMBER", []))).toBeNull()
  })

  it("scopes to the org slug and derives admin / read-only flags", async () => {
    mocks.getUserWorkspaces.mockResolvedValue([
      { id: WS_A, orgSlug: "acme", isReadOnly: false },
      { id: WS_B, orgSlug: "acme", isReadOnly: true },
      { id: "elsewhere", orgSlug: "other", isReadOnly: false },
    ])
    const result = await resolveRoadmapViewActor(ME, "acme", orgDb("ADMIN", [{ workspaceId: WS_A, role: "ADMIN" }]))
    expect(result).toEqual({
      userId: ME, organizationId: ORG, isOrgAdmin: true,
      workspaces: [{ id: WS_A, isReadOnly: false, isAdmin: true }, { id: WS_B, isReadOnly: true, isAdmin: false }],
    })
  })

  it("a read-only org fallback member (no membership rows) is neither admin nor workspace admin", async () => {
    mocks.getUserWorkspaces.mockResolvedValue([{ id: WS_A, orgSlug: "acme", isReadOnly: true }])
    const result = await resolveRoadmapViewActor(ME, "acme", orgDb(null, []))
    expect(result?.isOrgAdmin).toBe(false)
    expect(result?.workspaces[0]).toEqual({ id: WS_A, isReadOnly: true, isAdmin: false })
  })

  it("returns null when the org row is missing", async () => {
    mocks.getUserWorkspaces.mockResolvedValue([{ id: WS_A, orgSlug: "acme", isReadOnly: false }])
    expect(await resolveRoadmapViewActor(ME, "acme", orgDb(null, [], false))).toBeNull()
  })
})

describe("view CRUD", () => {
  it("creates a personal view stamped with owner, org and surface", async () => {
    const { db, rows } = makeStore()
    const created = await createRoadmapView(actor(), null, input({ filters: { horizons: ["NOW"] } }), db)
    expect(created).toMatchObject({ name: "Mine", visibility: "PERSONAL", workspaceId: null, ownerId: ME, isOwner: true })
    expect(created.filters.horizons).toEqual(["NOW"])
    expect(rows[0]).toMatchObject({ organizationId: ORG, ownerId: ME, workspaceId: null })
  })

  it("rejects invalid input, a foreign surface, read-only sharing and the per-surface cap", async () => {
    const { db } = makeStore()
    await expect(createRoadmapView(actor(), null, { name: "", filters: {}, display: {} }, db)).rejects.toMatchObject({ code: "INVALID" })
    await expect(createRoadmapView(actor(), WS_B, input(), db)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const ro = actor({ workspaces: [{ id: WS_A, isReadOnly: true, isAdmin: false }] })
    await expect(createRoadmapView(ro, null, input({ visibility: "SHARED" }), db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(createRoadmapView(ro, null, input(), db)).resolves.toBeDefined()

    const full = makeStore(Array.from({ length: MAX_VIEWS_PER_OWNER_PER_SURFACE }, (_, i) => row({ id: `v${i}` })))
    await expect(createRoadmapView(actor(), null, input(), full.db)).rejects.toMatchObject({ code: "LIMIT" })
    // the cap is per surface
    await expect(createRoadmapView(actor(), WS_A, input(), full.db)).resolves.toBeDefined()
  })

  it("lists own + shared views for the surface only, never another user's personal view", async () => {
    const { db } = makeStore([
      row({ id: "mine", name: "B mine" }),
      row({ id: "shared", ownerId: OTHER, visibility: "SHARED", name: "A shared" }),
      row({ id: "theirs", ownerId: OTHER, visibility: "PERSONAL" }),
      row({ id: "ws-view", workspaceId: WS_A }),
      row({ id: "other-org", organizationId: "zzz", visibility: "SHARED", ownerId: OTHER }),
    ])
    const listed = await listRoadmapViews(actor(), null, db)
    // shared-by-others first, then the actor's own; each group by name
    expect(listed.map((v) => v.id)).toEqual(["shared", "mine"])
    expect(listed.find((v) => v.id === "shared")?.isOwner).toBe(false)
  })

  it("canDelete mirrors the server rule: owner, or a surface admin on a SHARED view", async () => {
    const seed = [
      row({ id: "theirs-shared", ownerId: OTHER, visibility: "SHARED" }),
      row({ id: "mine-personal" }),
    ]
    const member = await listRoadmapViews(actor(), null, makeStore(seed).db)
    expect(member.find((v) => v.id === "theirs-shared")).toMatchObject({ isOwner: false, canDelete: false })
    expect(member.find((v) => v.id === "mine-personal")).toMatchObject({ isOwner: true, canDelete: true })
    const admin = await listRoadmapViews(actor({ isOrgAdmin: true }), null, makeStore(seed).db)
    expect(admin.find((v) => v.id === "theirs-shared")).toMatchObject({ isOwner: false, canDelete: true })
  })

  it("lists nothing on a surface the actor cannot use", async () => {
    const { db } = makeStore([row({ id: "x", workspaceId: WS_B })])
    expect(await listRoadmapViews(actor(), WS_B, db)).toEqual([])
  })

  it("a corrupt stored document degrades to defaults instead of failing", async () => {
    const { db } = makeStore([row({ id: "bad", filters: { horizons: ["GONE"] }, display: "junk" })])
    const view = await getRoadmapView(actor(), null, "bad", db)
    expect(view?.filters.horizons).toEqual([])
    expect(view?.display).toEqual({ view: "board", groupBy: "horizon", sort: "manual" })
  })

  it("getRoadmapView hides other people's personal views and views on another surface", async () => {
    const { db } = makeStore([row({ id: "p", ownerId: OTHER }), row({ id: "w", workspaceId: WS_A })])
    expect(await getRoadmapView(actor(), null, "p", db)).toBeNull()
    expect(await getRoadmapView(actor(), null, "w", db)).toBeNull()
    expect(await getRoadmapView(actor(), WS_A, "w", db)).not.toBeNull()
  })

  it("owner updates; the write is scoped to the owner", async () => {
    const { db, rows } = makeStore([row({ id: "v" })])
    const updated = await updateRoadmapView(actor(), null, "v", input({ name: "Renamed", visibility: "SHARED" }), db)
    expect(updated).toMatchObject({ name: "Renamed", visibility: "SHARED" })
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(0)
  })

  it("a non-owner cannot edit a shared view (403) and cannot discover a personal one (404)", async () => {
    const { db } = makeStore([row({ id: "s", ownerId: OTHER, visibility: "SHARED" }), row({ id: "p", ownerId: OTHER })])
    await expect(updateRoadmapView(actor(), null, "s", input(), db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(updateRoadmapView(actor({ isOrgAdmin: true }), null, "s", input(), db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(updateRoadmapView(actor(), null, "p", input(), db)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("delete: owner yes; stranger on shared no; admin on shared yes; missing is NOT_FOUND", async () => {
    const { db, rows } = makeStore([row({ id: "mine" }), row({ id: "s", ownerId: OTHER, visibility: "SHARED" }), row({ id: "s2", ownerId: OTHER, visibility: "SHARED" })])
    await deleteRoadmapView(actor(), null, "mine", db)
    expect(rows.map((r) => r.id)).toEqual(["s", "s2"])
    await expect(deleteRoadmapView(actor(), null, "s", db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await deleteRoadmapView(actor({ isOrgAdmin: true }), null, "s2", db)
    expect(rows.map((r) => r.id)).toEqual(["s"])
    await expect(deleteRoadmapView(actor(), null, "nope", db)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: ME } })
    mocks.getUserWorkspaces.mockResolvedValue([{ id: WS_A, orgSlug: "acme", isReadOnly: false }])
    const store = makeStore()
    mocks.db = {
      ...(store.db as object),
      organization: { findUnique: async () => ({ id: ORG }) },
      organizationMember: { findFirst: async () => ({ role: "MEMBER" }) },
      workspaceMember: { findMany: async () => [{ workspaceId: WS_A, role: "MEMBER" }] },
    }
  })

  it("rejects unauthenticated callers without touching the db", async () => {
    mocks.auth.mockResolvedValue(null)
    expect(await createRoadmapViewAction("acme", null, input())).toEqual({ ok: false, error: "Unauthorized" })
  })

  it("rejects a malformed surface or view id before any lookup", async () => {
    expect(await createRoadmapViewAction("acme", "not-a-uuid", input())).toEqual({ ok: false, error: "Invalid roadmap" })
    expect(await updateRoadmapViewAction("acme", null, "nope", input())).toEqual({ ok: false, error: "View not found" })
    expect(await deleteRoadmapViewAction("acme", null, "nope")).toEqual({ ok: false, error: "View not found" })
  })

  it("treats an org the user cannot reach as not found", async () => {
    mocks.getUserWorkspaces.mockResolvedValue([])
    expect(await createRoadmapViewAction("acme", null, input())).toEqual({ ok: false, error: "Roadmap not found" })
  })

  it("creates, maps service errors to { ok: false }, and revalidates on success only", async () => {
    const ok = await createRoadmapViewAction("acme", null, input())
    expect(ok).toMatchObject({ ok: true, view: { name: "Mine", isOwner: true } })
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/roadmap")
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/[workspaceSlug]/roadmap", "page")

    mocks.revalidatePath.mockClear()
    const bad = await createRoadmapViewAction("acme", null, { name: "", filters: {}, display: {} })
    expect(bad).toMatchObject({ ok: false })
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  it("round-trips update and delete through the actions", async () => {
    const created = await createRoadmapViewAction("acme", null, input())
    if (!created.ok) throw new Error("create failed")
    const id = created.view.id
    const renamed = await updateRoadmapViewAction("acme", null, id, input({ name: "Renamed" }))
    expect(renamed).toMatchObject({ ok: true, view: { id, name: "Renamed" } })
    expect(await deleteRoadmapViewAction("acme", null, id)).toEqual({ ok: true })
    expect(await deleteRoadmapViewAction("acme", null, id)).toEqual({ ok: false, error: "View not found" })
  })
})
