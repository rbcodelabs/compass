/** resolveDocEmbedRefs and loadScopeSpecs (server actions): who may call them, and that the workspace comes from the doc / the session. */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  docFindUnique: vi.fn(),
  workspaceFindFirst: vi.fn(),
  resolveDocEmbeds: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  loadScopeSpecItems: vi.fn(),
}))

vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({
  default: () => ({ doc: { findUnique: mocks.docFindUnique }, workspace: { findFirst: mocks.workspaceFindFirst } }),
}))
vi.mock("@/lib/canvas-card-data", () => ({ resolveDocEmbeds: mocks.resolveDocEmbeds, resolveCanvasCards: vi.fn(), searchCanvasCardTargets: vi.fn() }))
vi.mock("@/lib/workspace-context", () => ({ resolveWorkspaceAccess: mocks.resolveWorkspaceAccess }))
vi.mock("@/lib/spec-docs/view", () => ({ loadScopeSpecItems: mocks.loadScopeSpecItems }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))

import { resolveDocEmbedRefs, loadScopeSpecs } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

const DOC = "33333333-3333-4333-8333-333333333333"
const WS = "11111111-1111-4111-8111-111111111111"
const SCOPE = "22222222-2222-4222-8222-222222222222"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  mocks.docFindUnique.mockResolvedValue({ workspaceId: WS })
  mocks.workspaceFindFirst.mockResolvedValue({ id: WS, slug: "alpha", organization: { slug: "acme" } })
  mocks.resolveDocEmbeds.mockResolvedValue({ cards: {}, deferred: [] })
})

describe("resolveDocEmbedRefs", () => {
  it("passes only the viewer, the doc id and the doc's workspace to the resolver, never anything from the references", async () => {
    const refs = [{ kind: "task", id: "x", workspaceId: "forged-ws" }]
    await resolveDocEmbedRefs(DOC, refs)
    expect(mocks.resolveDocEmbeds).toHaveBeenCalledWith({ docId: DOC, userId: "user-1", refs, expectedWorkspaceId: WS })
  })

  it("rejects anonymous callers, a missing doc, and a viewer with no access to the doc's workspace", async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(resolveDocEmbedRefs(DOC, [])).rejects.toThrow("Unauthorized")
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.docFindUnique.mockResolvedValue(null)
    await expect(resolveDocEmbedRefs(DOC, [])).rejects.toThrow("Document not found")
    mocks.docFindUnique.mockResolvedValue({ workspaceId: WS })
    mocks.workspaceFindFirst.mockResolvedValue(null)
    await expect(resolveDocEmbedRefs(DOC, [])).rejects.toThrow("Workspace not found or access denied")
    expect(mocks.resolveDocEmbeds).not.toHaveBeenCalled()
  })

  it("returns an empty resolution for a non-array and bounds how many references it looks at", async () => {
    expect(await resolveDocEmbedRefs(DOC, "nope")).toEqual({ cards: {}, deferred: [] })
    expect(mocks.resolveDocEmbeds).not.toHaveBeenCalled()
    await resolveDocEmbedRefs(DOC, Array.from({ length: 5000 }, (_, i) => ({ kind: "task", id: String(i) })))
    expect(mocks.resolveDocEmbeds.mock.calls[0][0].refs).toHaveLength(500)
  })

  it("a doc the resolver cannot find (deleted meanwhile) is an error, not an empty result", async () => {
    mocks.resolveDocEmbeds.mockResolvedValue(null)
    await expect(resolveDocEmbedRefs(DOC, [])).rejects.toThrow("Document not found")
  })
})

describe("loadScopeSpecs", () => {
  const items = [{ id: "d1", title: "Spec - X", label: null, updatedAt: "2026-01-01T00:00:00.000Z", href: "/acme/alpha/docs/d1" }]

  it("a member may create", async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({ workspaceId: WS, isReadOnly: false })
    mocks.loadScopeSpecItems.mockResolvedValue(items)
    expect(await loadScopeSpecs("acme", "alpha", "SOLUTION", SCOPE)).toEqual({ workspaceId: WS, canCreate: true, specs: items })
    expect(mocks.loadScopeSpecItems).toHaveBeenCalledWith({ workspaceId: WS, orgSlug: "acme", workspaceSlug: "alpha", scopeType: "SOLUTION", scopeId: SCOPE })
  })

  it("an org-wide read-only member reads the specs but cannot create", async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue({ workspaceId: WS, isReadOnly: true })
    mocks.loadScopeSpecItems.mockResolvedValue(items)
    expect(await loadScopeSpecs("acme", "alpha", "OPPORTUNITY", SCOPE)).toMatchObject({ canCreate: false, specs: items })
  })

  it("no access is an error; a scope outside the workspace and a malformed scope read as empty and not creatable", async () => {
    mocks.resolveWorkspaceAccess.mockResolvedValue(null)
    await expect(loadScopeSpecs("acme", "alpha", "SOLUTION", SCOPE)).rejects.toThrow("Workspace not found or access denied")
    mocks.resolveWorkspaceAccess.mockResolvedValue({ workspaceId: WS, isReadOnly: false })
    mocks.loadScopeSpecItems.mockResolvedValue(null)
    expect(await loadScopeSpecs("acme", "alpha", "SOLUTION", SCOPE)).toEqual({ workspaceId: WS, canCreate: false, specs: [] })
    expect(await loadScopeSpecs("acme", "alpha", "SOLUTION", "not-a-uuid")).toEqual({ workspaceId: WS, canCreate: false, specs: [] })
    expect(await loadScopeSpecs("acme", "alpha", "BOGUS" as never, SCOPE)).toEqual({ workspaceId: WS, canCreate: false, specs: [] })
  })

  it("anonymous callers are refused", async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(loadScopeSpecs("acme", "alpha", "SOLUTION", SCOPE)).rejects.toThrow("Unauthorized")
  })
})
