import { describe, expect, it } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { excerptOf, getPublishedDoc, listPublishedDocs, setDocPublished } from "@/lib/portal-docs/service"

/**
 * Public doc scoping. The fake store implements the where-semantics the service relies on (workspaceId,
 * publishedAt not null, storageProvider OR, id in/equals), so dropping any predicate fails a test.
 */
const WS = "11111111-1111-4111-8111-111111111111"
const OTHER_WS = "22222222-2222-4222-8222-222222222222"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const d = (day: number) => new Date(Date.UTC(2026, 8, day))

interface DocRow {
  id: string
  workspaceId: string
  title: string
  content: string | null
  storageProvider: string | null
  publishedAt: Date | null
  publishedById: string | null
  updatedAt: Date
  // columns that must never reach a customer
  createdById: string
  metadata: unknown
  contentRef: string | null
}
const row = (n: number, over: Partial<DocRow> = {}): DocRow => ({
  id: id(n), workspaceId: WS, title: `Doc ${n}`, content: `# Heading\n\nBody ${n}`, storageProvider: null, publishedAt: null, publishedById: null,
  updatedAt: d(n), createdById: "author-uuid-PRIVATE", metadata: { secret: "PRIVATE-META" }, contentRef: null, ...over,
})

function matches(r: DocRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((alt) => matches(r, alt))
    const value = (r as unknown as Record<string, unknown>)[key]
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown }
      if (c.in) return c.in.includes(value)
      if ("not" in c) return value !== c.not
    }
    return value === cond
  })
}
const pick = (r: DocRow, select?: Record<string, boolean>) => {
  if (!select) throw new Error("public reads must use an explicit select")
  return Object.fromEntries(Object.keys(select).map((k) => [k, (r as unknown as Record<string, unknown>)[k]]))
}

function fake(rows: DocRow[], members: Array<{ workspaceId: string; userId: string }> = []) {
  return {
    doc: {
      findMany: async (a: { where: Record<string, unknown>; take?: number; select?: Record<string, boolean> }) =>
        rows.filter((r) => matches(r, a.where)).sort((x, y) => (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0)).slice(0, a.take ?? rows.length).map((r) => pick(r, a.select)),
      findFirst: async (a: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const found = rows.find((r) => matches(r, a.where))
        return found ? pick(found, a.select) : null
      },
      findUnique: async (a: { where: { id: string }; select?: Record<string, boolean> }) => {
        const found = rows.find((r) => r.id === a.where.id)
        return found ? pick(found, a.select) : null
      },
      updateMany: async (a: { where: { id: string; workspaceId: string }; data: Partial<DocRow> }) => {
        const targets = rows.filter((r) => r.id === a.where.id && r.workspaceId === a.where.workspaceId)
        targets.forEach((r) => Object.assign(r, a.data))
        return { count: targets.length }
      },
    },
    workspace: {
      findFirst: async (a: { where: { id: string; members: { some: { userId: string } } } }) =>
        members.some((m) => m.workspaceId === a.where.id && m.userId === a.where.members.some.userId) ? { id: a.where.id } : null,
    },
  } as unknown as AppPrismaClient
}

describe("getPublishedDoc / listPublishedDocs scoping", () => {
  const rows = [
    row(1, { publishedAt: d(10) }),
    row(2), // unpublished
    row(3, { workspaceId: OTHER_WS, publishedAt: d(11) }), // published, other workspace
    row(4, { publishedAt: d(12), storageProvider: "GEODE", contentRef: "{}" }), // external body: fail closed
    row(5, { publishedAt: d(13), storageProvider: "OTHER" }),
  ]

  it("reads a published doc in its own workspace", async () => {
    const doc = await getPublishedDoc(fake(rows), WS, id(1))
    expect(doc).toMatchObject({ id: id(1), title: "Doc 1", body: "# Heading\n\nBody 1", excerpt: "Heading Body 1" })
  })

  it("returns only the allow-listed fields: no author, metadata, revision or storage reference", async () => {
    const doc = await getPublishedDoc(fake(rows), WS, id(1))
    expect(Object.keys(doc!).sort()).toEqual(["body", "excerpt", "id", "publishedAt", "title", "updatedAt"])
    const list = await listPublishedDocs(fake(rows), WS)
    for (const item of list) expect(Object.keys(item).sort()).toEqual(["excerpt", "id", "publishedAt", "title", "updatedAt"])
    const wire = JSON.stringify([doc, list])
    expect(wire).not.toContain("PRIVATE")
  })

  it("404s (null) for a cross-workspace doc id, an unpublished doc, an externally stored doc and malformed ids", async () => {
    const prisma = fake(rows)
    expect(await getPublishedDoc(prisma, WS, id(3))).toBeNull()
    expect(await getPublishedDoc(prisma, OTHER_WS, id(1))).toBeNull()
    expect(await getPublishedDoc(prisma, WS, id(2))).toBeNull()
    expect(await getPublishedDoc(prisma, WS, id(4))).toBeNull()
    expect(await getPublishedDoc(prisma, WS, id(99))).toBeNull()
    expect(await getPublishedDoc(prisma, WS, "not-a-uuid")).toBeNull()
    expect(await getPublishedDoc(prisma, WS, "' OR 1=1 --")).toBeNull()
  })

  it("lists only this workspace's published docs, newest publish first", async () => {
    const list = await listPublishedDocs(fake(rows), WS)
    expect(list.map((x) => x.id)).toEqual([id(5), id(1)])
  })

  it("with ids, keeps the requested order and drops unpublished/foreign ids", async () => {
    const list = await listPublishedDocs(fake(rows), WS, { ids: [id(5), id(2), id(3), id(1), "garbage"] })
    expect(list.map((x) => x.id)).toEqual([id(5), id(1)])
    expect(await listPublishedDocs(fake(rows), WS, { ids: [] })).toEqual([])
  })
})

describe("setDocPublished", () => {
  const member = { workspaceId: WS, userId: "user-1" }

  it("publishes for a workspace member, then unpublish immediately removes it from reads and lists", async () => {
    const rows = [row(1)]
    const prisma = fake(rows, [member])
    expect(await getPublishedDoc(prisma, WS, id(1))).toBeNull()

    const published = await setDocPublished(prisma, { userId: "user-1", docId: id(1), published: true })
    expect(published).toMatchObject({ docId: id(1), workspaceId: WS, published: true })
    expect(rows[0].publishedById).toBe("user-1")
    expect((await listPublishedDocs(prisma, WS)).map((x) => x.id)).toEqual([id(1)])
    expect(await getPublishedDoc(prisma, WS, id(1))).not.toBeNull()

    const unpublished = await setDocPublished(prisma, { userId: "user-1", docId: id(1), published: false })
    expect(unpublished).toMatchObject({ published: false, publishedAt: null })
    expect(rows[0].publishedAt).toBeNull()
    expect(rows[0].publishedById).toBeNull()
    expect(await listPublishedDocs(prisma, WS)).toEqual([])
    expect(await getPublishedDoc(prisma, WS, id(1))).toBeNull()
  })

  it("is idempotent: republishing keeps the original publishedAt", async () => {
    const rows = [row(1, { publishedAt: d(10), publishedById: "someone" })]
    const result = await setDocPublished(fake(rows, [member]), { userId: "user-1", docId: id(1), published: true })
    expect(result.publishedAt).toBe(d(10).toISOString())
    expect(rows[0].publishedById).toBe("someone")
  })

  it("rejects a non-member with 'Workspace not found' and changes nothing (no cross-workspace existence leak)", async () => {
    const rows = [row(1)]
    const prisma = fake(rows, [{ workspaceId: OTHER_WS, userId: "user-1" }])
    await expect(setDocPublished(prisma, { userId: "user-1", docId: id(1), published: true })).rejects.toMatchObject({ code: "not_found" })
    await expect(setDocPublished(prisma, { userId: "user-1", docId: id(1), published: true })).rejects.toThrow("Workspace not found")
    await expect(setDocPublished(prisma, { userId: "user-1", docId: id(99), published: true })).rejects.toThrow("Workspace not found")
    await expect(setDocPublished(prisma, { userId: "user-1", docId: "nope", published: true })).rejects.toThrow("Workspace not found")
    expect(rows[0].publishedAt).toBeNull()
  })

  it("rejects an anonymous caller", async () => {
    await expect(setDocPublished(fake([row(1)]), { userId: "", docId: id(1), published: true })).rejects.toMatchObject({ code: "unauthorized" })
  })

  it("refuses to publish an externally stored doc, but allows unpublishing one", async () => {
    const rows = [row(1, { storageProvider: "GEODE", contentRef: "{}" })]
    const prisma = fake(rows, [member])
    await expect(setDocPublished(prisma, { userId: "user-1", docId: id(1), published: true })).rejects.toMatchObject({ name: "DocPublishError", code: "unsupported" })
    expect(rows[0].publishedAt).toBeNull()
    rows[0].publishedAt = d(5)
    await setDocPublished(prisma, { userId: "user-1", docId: id(1), published: false })
    expect(rows[0].publishedAt).toBeNull()
  })
})

describe("excerptOf", () => {
  it("strips markdown, code fences, html and links, and truncates", () => {
    expect(excerptOf("# Title\n\nSee [the guide](http://x) and **bold** `code`\n```\nsecret code\n```\n<script>alert(1)</script>")).toBe("Title See the guide and bold code alert(1)")
    expect(excerptOf(null)).toBe("")
    expect(excerptOf("a".repeat(500))).toHaveLength(181)
  })
})

describe("before migration 113 is applied", () => {
  const missing = Object.assign(new Error("column does not exist"), { code: "P2022" })
  const broken = (error: unknown) => ({ doc: { findMany: async () => { throw error }, findFirst: async () => { throw error } } }) as unknown as AppPrismaClient

  it("fails closed (nothing is public) on a missing column, but still throws other database errors", async () => {
    expect(await listPublishedDocs(broken(missing), WS)).toEqual([])
    expect(await getPublishedDoc(broken(missing), WS, id(1))).toBeNull()
    await expect(listPublishedDocs(broken(new Error("connection lost")), WS)).rejects.toThrow("connection lost")
    await expect(getPublishedDoc(broken(new Error("connection lost")), WS, id(1))).rejects.toThrow("connection lost")
  })
})
