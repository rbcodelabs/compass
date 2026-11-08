/**
 * POST /api/docs/[docId]/publish: session-gated, workspace-member authorized, and unpublish takes effect on the
 * very next public read (no caching in between).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const WS = "11111111-1111-4111-8111-111111111111"
const DOC = "00000000-0000-4000-8000-000000000001"
const authMock = vi.fn()
const revalidatePath = vi.fn()

const state = { publishedAt: null as Date | null, publishedById: null as string | null, members: ["user-1"], storageProvider: null as string | null }
const prisma = {
  doc: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === DOC ? { id: DOC, workspaceId: WS, storageProvider: state.storageProvider, publishedAt: state.publishedAt } : null),
    updateMany: vi.fn(async ({ data }: { data: { publishedAt: Date | null; publishedById: string | null } }) => {
      state.publishedAt = data.publishedAt
      state.publishedById = data.publishedById
      return { count: 1 }
    }),
  },
  workspace: {
    findFirst: vi.fn(async ({ where }: { where: { members: { some: { userId: string } } } }) => (state.members.includes(where.members.some.userId) ? { id: WS } : null)),
    findUnique: vi.fn(async () => ({ slug: "main", organization: { slug: "acme" } })),
  },
}

vi.mock("@/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))

const params = (docId = DOC) => ({ params: Promise.resolve({ docId }) })
const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  state.publishedAt = null
  state.publishedById = null
  state.members = ["user-1"]
  state.storageProvider = null
  authMock.mockResolvedValue({ user: { id: "user-1" } })
})

describe("doc publish route", () => {
  it("401s without a session and touches no data", async () => {
    authMock.mockResolvedValue(null)
    const { POST } = await import("@/app/api/docs/[docId]/publish/route")
    expect((await POST(post({ published: true }), params())).status).toBe(401)
    expect(prisma.doc.updateMany).not.toHaveBeenCalled()
  })

  it("404s for a signed-in user who is not a member of the doc's workspace, and for an unknown doc", async () => {
    state.members = ["someone-else"]
    const { POST } = await import("@/app/api/docs/[docId]/publish/route")
    expect((await POST(post({ published: true }), params())).status).toBe(404)
    expect((await POST(post({ published: true }), params("00000000-0000-4000-8000-0000000000ff"))).status).toBe(404)
    expect(prisma.doc.updateMany).not.toHaveBeenCalled()
    expect(state.publishedAt).toBeNull()
  })

  it("publishes then unpublishes for a member, revalidating the portal each time", async () => {
    const { POST } = await import("@/app/api/docs/[docId]/publish/route")
    const published = await POST(post({ published: true }), params())
    expect(published.status).toBe(200)
    expect(await published.json()).toMatchObject({ id: DOC, published: true })
    expect(state.publishedAt).toBeInstanceOf(Date)
    expect(state.publishedById).toBe("user-1")

    const unpublished = await POST(post({ published: false }), params())
    expect(await unpublished.json()).toEqual({ id: DOC, published: false, publishedAt: null })
    expect(state.publishedAt).toBeNull()
    expect(revalidatePath).toHaveBeenCalledTimes(2)
    expect(revalidatePath).toHaveBeenCalledWith("/portal/acme/main", "layout")
  })

  it("400s on a bad body or malformed JSON, 409s for an externally stored doc", async () => {
    const { POST } = await import("@/app/api/docs/[docId]/publish/route")
    expect((await POST(post({ published: "yes" }), params())).status).toBe(400)
    expect((await POST(new Request("http://x", { method: "POST", body: "{nope" }), params())).status).toBe(400)
    state.storageProvider = "GEODE"
    expect((await POST(post({ published: true }), params())).status).toBe(409)
    expect(state.publishedAt).toBeNull()
  })
})
