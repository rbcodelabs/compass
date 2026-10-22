import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ getUserWorkspaces: vi.fn(), auth: vi.fn(), revalidatePath: vi.fn(), db: {} as Record<string, unknown> }))
vi.mock("@/lib/workspace", () => ({ getUserWorkspaces: mocks.getUserWorkspaces }))
vi.mock("@/lib/db", () => ({ default: () => mocks.db }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }))

import type { SavedViewActor } from "@/lib/saved-views/access"
import {
  createSavedView, deleteSavedView, getSavedView, listSavedViews, updateSavedView,
} from "@/lib/saved-views/service"
import { isConsistentScope, legacySurfaceFor, resolveRowSurface } from "@/lib/saved-views/surfaces"
import { createSavedViewAction, deleteSavedViewAction, updateSavedViewAction } from "@/app/[orgSlug]/saved-views-actions"
import { updateRoadmapViewAction } from "@/app/[orgSlug]/roadmap/actions"

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const WS_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const WS_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ME = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

type Row = {
  id: string; organizationId: string; workspaceId: string | null; ownerId: string; name: string
  visibility: string; surface: string | null; filters: unknown; display: unknown; createdAt: Date; updatedAt: Date
}

/** Minimal in-memory stand-in for the prisma delegate; honours the where shapes the service uses. */
function makeStore(seed: Row[] = []) {
  const rows = [...seed]
  const match = (r: Row, w: Record<string, unknown>): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === "OR") return (v as Record<string, unknown>[]).some((c) => match(r, c))
      if (k === "AND") return (v as Record<string, unknown>[]).every((c) => match(r, c))
      if (k === "NOT") return !match(r, v as Record<string, unknown>)
      return (r as Record<string, unknown>)[k] === v
    })
  const savedView = {
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
  return { rows, db: { savedView } as never }
}

const row = (over: Partial<Row>): Row => ({
  id: "seed", organizationId: ORG, workspaceId: WS_A, ownerId: ME, name: "Seed", visibility: "PERSONAL", surface: "OPPORTUNITIES_BOARD",
  filters: {}, display: {}, createdAt: new Date(0), updatedAt: new Date(1000), ...over,
})
const actor = (over: Partial<SavedViewActor> = {}): SavedViewActor => ({
  userId: ME, organizationId: ORG, isOrgAdmin: false, workspaces: [{ id: WS_A, isReadOnly: false, isAdmin: false }], ...over,
})
const input = (over: Record<string, unknown> = {}) => ({ name: "Mine", filters: {}, display: {}, ...over })

describe("surfaces", () => {
  it("derives the surface of a legacy NULL row from its workspace id", () => {
    expect(legacySurfaceFor(null)).toBe("ROADMAP_ORG")
    expect(legacySurfaceFor(WS_A)).toBe("ROADMAP_WORKSPACE")
    expect(resolveRowSurface({ surface: null, workspaceId: null })).toBe("ROADMAP_ORG")
    expect(resolveRowSurface({ surface: null, workspaceId: WS_A })).toBe("ROADMAP_WORKSPACE")
    expect(resolveRowSurface({ surface: "SOLUTIONS_BOARD", workspaceId: WS_A })).toBe("SOLUTIONS_BOARD")
    expect(resolveRowSurface({ surface: "NOT_A_SURFACE", workspaceId: WS_A })).toBe("ROADMAP_WORKSPACE")
  })

  it("requires a workspace for every surface except ROADMAP_ORG", () => {
    expect(isConsistentScope("ROADMAP_ORG", null)).toBe(true)
    expect(isConsistentScope("ROADMAP_ORG", WS_A)).toBe(false)
    expect(isConsistentScope("OPPORTUNITIES_BOARD", WS_A)).toBe(true)
    expect(isConsistentScope("OPPORTUNITIES_BOARD", null)).toBe(false)
    expect(isConsistentScope("ROADMAP_WORKSPACE", null)).toBe(false)
  })
})

describe("saved view service on the board surfaces", () => {
  it("creates a personal view stamped with its surface and validates the board document", async () => {
    const { db, rows } = makeStore()
    const created = await createSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, input({
      display: { sort: "score", columns: { status: { order: ["EXPLORING", "GONE"], hidden: ["ACTIVE"] } } },
    }), db)
    expect(rows[0]).toMatchObject({ surface: "OPPORTUNITIES_BOARD", workspaceId: WS_A, ownerId: ME })
    expect(created).toMatchObject({ surface: "OPPORTUNITIES_BOARD", isOwner: true })
    // unknown status dropped on parse, known ones kept
    expect((created.display as { columns: unknown }).columns).toEqual({ status: { order: ["EXPLORING"], hidden: ["ACTIVE"] } })
  })

  it("rejects an invalid board document and an inconsistent surface/workspace pair", async () => {
    const { db } = makeStore()
    await expect(createSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, input({ display: { sort: "bogus" } }), db)).rejects.toMatchObject({ code: "INVALID" })
    await expect(createSavedView(actor(), "OPPORTUNITIES_BOARD", null, input(), db)).rejects.toMatchObject({ code: "INVALID" })
    await expect(createSavedView(actor(), "ROADMAP_ORG", WS_A, input(), db)).rejects.toMatchObject({ code: "INVALID" })
  })

  it("rejects SHARED on surfaces with sharing off, on create and on update", async () => {
    const { db } = makeStore([row({ id: "v" })])
    await expect(createSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, input({ visibility: "SHARED" }), db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(updateSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "v", input({ visibility: "SHARED" }), undefined, db)).rejects.toMatchObject({ code: "FORBIDDEN" })
    // the same visibility is fine on the roadmap
    await expect(createSavedView(actor(), "ROADMAP_WORKSPACE", WS_A, input({ visibility: "SHARED" }), db)).resolves.toBeDefined()
  })

  it("rejects a duplicate name per owner and surface, but allows it on another surface or another owner", async () => {
    const { db } = makeStore([row({ id: "a", name: "Mine" }), row({ id: "b", name: "Taken", ownerId: OTHER })])
    await expect(createSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, input({ name: "Mine" }), db)).rejects.toMatchObject({ code: "INVALID" })
    await expect(createSavedView(actor(), "SOLUTIONS_BOARD", WS_A, input({ name: "Mine" }), db)).resolves.toBeDefined()
    await expect(createSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, input({ name: "Taken" }), db)).resolves.toBeDefined()
    // renaming a view to its own name is not a clash
    await expect(updateSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "a", input({ name: "Mine" }), undefined, db)).resolves.toBeDefined()
  })

  it("enforces the per-surface cap of 50", async () => {
    const full = makeStore(Array.from({ length: 50 }, (_, i) => row({ id: `v${i}`, name: `View ${i}` })))
    await expect(createSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, input(), full.db)).rejects.toMatchObject({ code: "LIMIT" })
    await expect(createSavedView(actor(), "SOLUTIONS_BOARD", WS_A, input(), full.db)).resolves.toBeDefined()
  })

  it("isolates by surface, workspace and org when listing and getting", async () => {
    const { db } = makeStore([
      row({ id: "opp" }),
      row({ id: "sol", surface: "SOLUTIONS_BOARD" }),
      row({ id: "roadmap", surface: "ROADMAP_WORKSPACE" }),
      row({ id: "legacy-roadmap", surface: null }),
      row({ id: "other-ws", workspaceId: WS_B }),
      row({ id: "other-org", organizationId: "zzz", visibility: "SHARED", ownerId: OTHER }),
    ])
    const wsBActor = actor({ workspaces: [{ id: WS_A, isReadOnly: false, isAdmin: false }, { id: WS_B, isReadOnly: false, isAdmin: false }] })
    expect((await listSavedViews(wsBActor, "OPPORTUNITIES_BOARD", WS_A, db)).map((v) => v.id)).toEqual(["opp"])
    expect((await listSavedViews(wsBActor, "SOLUTIONS_BOARD", WS_A, db)).map((v) => v.id)).toEqual(["sol"])
    expect((await listSavedViews(wsBActor, "OPPORTUNITIES_BOARD", WS_B, db)).map((v) => v.id)).toEqual(["other-ws"])
    expect(await getSavedView(actor(), "SOLUTIONS_BOARD", WS_A, "opp", db)).toBeNull()
    expect(await getSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "opp", db)).not.toBeNull()
  })

  it("lists nothing for a workspace the actor cannot use", async () => {
    const { db } = makeStore([row({ id: "x", workspaceId: WS_B })])
    expect(await listSavedViews(actor(), "OPPORTUNITIES_BOARD", WS_B, db)).toEqual([])
  })
})

describe("legacy NULL-surface rows", () => {
  it("are read as the roadmap surface derived from their workspace, and nowhere else", async () => {
    const { db } = makeStore([
      row({ id: "org-legacy", surface: null, workspaceId: null }),
      row({ id: "ws-legacy", surface: null, workspaceId: WS_A }),
    ])
    const org = await listSavedViews(actor(), "ROADMAP_ORG", null, db)
    expect(org).toMatchObject([{ id: "org-legacy", surface: "ROADMAP_ORG" }])
    const ws = await listSavedViews(actor(), "ROADMAP_WORKSPACE", WS_A, db)
    expect(ws).toMatchObject([{ id: "ws-legacy", surface: "ROADMAP_WORKSPACE" }])
    expect(await listSavedViews(actor(), "OPPORTUNITIES_BOARD", WS_A, db)).toEqual([])
    expect(await getSavedView(actor(), "ROADMAP_WORKSPACE", WS_A, "ws-legacy", db)).not.toBeNull()
  })

  it("get its surface stamped by the next update", async () => {
    const { db, rows } = makeStore([row({ id: "ws-legacy", surface: null, workspaceId: WS_A })])
    await updateSavedView(actor(), "ROADMAP_WORKSPACE", WS_A, "ws-legacy", input({ name: "Renamed" }), undefined, db)
    expect(rows[0].surface).toBe("ROADMAP_WORKSPACE")
  })
})

describe("expectedUpdatedAt conflict check", () => {
  const seen = new Date(1000).toISOString()

  it("updates when the caller saw the current version", async () => {
    const { db, rows } = makeStore([row({ id: "v" })])
    const updated = await updateSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "v", input({ name: "New" }), seen, db)
    expect(updated.name).toBe("New")
    expect(updated.updatedAt).not.toBe(seen)
    expect(rows[0].updatedAt.getTime()).toBeGreaterThan(1000)
  })

  it("fails with CONFLICT, writing nothing, when the view changed since the caller loaded it", async () => {
    const { db, rows } = makeStore([row({ id: "v", name: "Other tab won" })])
    await expect(
      updateSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "v", input({ name: "Stale" }), new Date(500).toISOString(), db),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect(rows[0].name).toBe("Other tab won")
  })

  it("is optional so existing Roadmap callers keep last-write-wins", async () => {
    const { db } = makeStore([row({ id: "v" })])
    await expect(updateSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "v", input({ name: "New" }), undefined, db)).resolves.toBeDefined()
  })

  it("conflicts when a save lands between the check and the write", async () => {
    const store = makeStore([row({ id: "v" })])
    const racing = {
      savedView: {
        ...(store.db as unknown as { savedView: Record<string, unknown> }).savedView,
        // another tab saves after our read, before our write
        updateMany: async (args: { where: Record<string, unknown>; data: Partial<Row> }) => {
          store.rows[0].updatedAt = new Date(5000)
          return (store.db as unknown as { savedView: { updateMany: (a: unknown) => Promise<{ count: number }> } }).savedView.updateMany(args)
        },
      },
    } as never
    await expect(updateSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "v", input(), seen, racing)).rejects.toMatchObject({ code: "CONFLICT" })
  })
})

describe("delete", () => {
  it("is scoped to the surface", async () => {
    const { db, rows } = makeStore([row({ id: "v" })])
    await expect(deleteSavedView(actor(), "SOLUTIONS_BOARD", WS_A, "v", db)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await deleteSavedView(actor(), "OPPORTUNITIES_BOARD", WS_A, "v", db)
    expect(rows).toHaveLength(0)
  })
})

describe("generalized server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: ME } })
    mocks.getUserWorkspaces.mockResolvedValue([{ id: WS_A, orgSlug: "acme", isReadOnly: false }])
    mocks.db = {
      ...(makeStore().db as object),
      organization: { findUnique: async () => ({ id: ORG }) },
      organizationMember: { findFirst: async () => ({ role: "MEMBER" }) },
      workspaceMember: { findMany: async () => [{ workspaceId: WS_A, role: "MEMBER" }] },
    }
  })

  it("rejects unauthenticated callers, unknown surfaces and inconsistent scopes", async () => {
    mocks.auth.mockResolvedValue(null)
    expect(await createSavedViewAction("acme", "OPPORTUNITIES_BOARD", WS_A, input())).toEqual({ ok: false, error: "Unauthorized" })
    mocks.auth.mockResolvedValue({ user: { id: ME } })
    expect(await createSavedViewAction("acme", "NOPE" as never, WS_A, input())).toEqual({ ok: false, error: "Invalid view location" })
    expect(await createSavedViewAction("acme", "OPPORTUNITIES_BOARD", null, input())).toEqual({ ok: false, error: "Invalid view location" })
  })

  it("creates, conflicts on a stale update, and deletes, revalidating the surface page", async () => {
    const created = await createSavedViewAction("acme", "OPPORTUNITIES_BOARD", WS_A, input())
    if (!created.ok) throw new Error("create failed")
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/acme/[workspaceSlug]/discovery", "page")

    const stale = await updateSavedViewAction("acme", "OPPORTUNITIES_BOARD", WS_A, created.view.id, input({ name: "X" }), new Date(1).toISOString())
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed elsewhere/) })

    const fresh = await updateSavedViewAction("acme", "OPPORTUNITIES_BOARD", WS_A, created.view.id, input({ name: "X" }), created.view.updatedAt)
    expect(fresh).toMatchObject({ ok: true, view: { name: "X" } })

    expect(await deleteSavedViewAction("acme", "OPPORTUNITIES_BOARD", WS_A, created.view.id)).toEqual({ ok: true })
  })

  it("the Roadmap update action passes expectedUpdatedAt through", async () => {
    const created = await createSavedViewAction("acme", "ROADMAP_WORKSPACE", WS_A, input())
    if (!created.ok) throw new Error("create failed")
    const stale = await updateRoadmapViewAction("acme", WS_A, created.view.id, input({ name: "X" }), new Date(1).toISOString())
    expect(stale).toMatchObject({ ok: false })
    expect(await updateRoadmapViewAction("acme", WS_A, created.view.id, input({ name: "X" }))).toMatchObject({ ok: true })
  })
})
