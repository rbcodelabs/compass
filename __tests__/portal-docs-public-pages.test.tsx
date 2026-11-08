// @vitest-environment jsdom
/**
 * Security boundary of the PUBLIC portal doc pages (/portal/<org>/<ws>/docs and /docs/<id>).
 * The fake store implements the where-semantics the service relies on, so dropping any predicate in
 * publishedDocWhere (workspace, publishedAt, storage, doc type) fails a test here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { setDocPublished } from "@/lib/portal-docs/service"
import type { AppPrismaClient } from "@/lib/db"

const WS_A = "11111111-1111-4111-8111-111111111111"
const WS_B = "22222222-2222-4222-8222-222222222222"
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const day = (n: number) => new Date(Date.UTC(2026, 9, n))

interface DocRow {
  id: string
  workspaceId: string
  title: string
  content: string | null
  storageProvider: string | null
  docType: string
  publishedAt: Date | null
  publishedById: string | null
  updatedAt: Date
  createdById: string
  updatedById: string
  metadata: unknown
  contentRef: string | null
}
const row = (n: number, over: Partial<DocRow> = {}): DocRow => ({
  id: id(n), workspaceId: WS_A, title: `Doc ${n}`, content: `Body of doc ${n}`, storageProvider: null, docType: "STANDARD",
  publishedAt: null, publishedById: null, updatedAt: day(n), createdById: "author-id-PRIVATE", updatedById: "editor-id-PRIVATE",
  metadata: { owner: "owner-email-PRIVATE@example.com" }, contentRef: null, ...over,
})

let rows: DocRow[] = []

function matches(r: DocRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((alt) => matches(r, alt))
    if (key === "AND") return (cond as Record<string, unknown>[]).every((alt) => matches(r, alt))
    // A missing column is SQL NULL: `col <> x` is then NULL (excluded), only an explicit null/IS NULL branch keeps it.
    const value = (r as unknown as Record<string, unknown>)[key] ?? null
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown }
      if (c.in) return c.in.includes(value)
      if ("not" in c) return value !== null && value !== c.not
    }
    return value === cond
  })
}
function pick(r: DocRow, select?: Record<string, boolean>) {
  if (!select) throw new Error("public reads must use an explicit select")
  return Object.fromEntries(Object.keys(select).map((k) => [k, (r as unknown as Record<string, unknown>)[k]]))
}

const members = [{ workspaceId: WS_A, userId: "member-1" }]
const prisma = {
  workspace: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> & { slug?: string; members?: { some: { userId: string } }; id?: string } }) => {
      if (where.members) return members.some((m) => m.workspaceId === where.id && m.userId === where.members!.some.userId) ? { id: where.id } : null
      if (where.slug === "alpha") return { id: WS_A, name: "Alpha Co" }
      if (where.slug === "beta") return { id: WS_B, name: "Beta Co" }
      return null
    }),
  },
  doc: {
    findMany: vi.fn(async (a: { where: Record<string, unknown>; take?: number; select?: Record<string, boolean> }) =>
      rows.filter((r) => matches(r, a.where)).sort((x, y) => (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0)).slice(0, a.take ?? rows.length).map((r) => pick(r, a.select))),
    findFirst: vi.fn(async (a: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
      const found = rows.find((r) => matches(r, a.where))
      return found ? pick(found, a.select) : null
    }),
    findUnique: vi.fn(async (a: { where: { id: string }; select?: Record<string, boolean> }) => {
      const found = rows.find((r) => r.id === a.where.id)
      return found ? pick(found, a.select) : null
    }),
    updateMany: vi.fn(async (a: { where: { id: string; workspaceId: string }; data: Partial<DocRow> }) => {
      const targets = rows.filter((r) => r.id === a.where.id && r.workspaceId === a.where.workspaceId)
      targets.forEach((r) => Object.assign(r, a.data))
      return { count: targets.length }
    }),
  },
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" })
  },
}))

const docParams = (docId: string, ws = "alpha") => ({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: ws, docId }) })
const indexParams = (ws = "alpha") => ({ params: Promise.resolve({ orgSlug: "acme", workspaceSlug: ws }) })

async function renderDoc(docId: string, ws = "alpha") {
  const { default: Page } = await import("@/app/portal/[orgSlug]/[workspaceSlug]/docs/[docId]/page")
  return renderToStaticMarkup(await Page(docParams(docId, ws)))
}
async function renderIndex(ws = "alpha") {
  const { default: Page } = await import("@/app/portal/[orgSlug]/[workspaceSlug]/docs/page")
  return renderToStaticMarkup(await Page(indexParams(ws)))
}

beforeEach(() => {
  vi.clearAllMocks()
  rows = [
    row(1, { title: "Public guide", content: "# Intro\n\nHello **customer**.", publishedAt: day(3) }),
    row(2, { title: "Secret roadmap plan", content: "TOP-SECRET-DRAFT-BODY" }),
    row(3, { title: "Beta only doc", workspaceId: WS_B, content: "BETA-BODY", publishedAt: day(4) }),
    row(4, { title: "External doc", storageProvider: "GEODE", content: null, publishedAt: day(5) }),
    row(5, { title: "Canvas doc", docType: "CANVAS", content: '{"nodes":[]}', publishedAt: day(6) }),
    row(6, { title: "Second guide", content: "More.", publishedAt: day(7) }),
  ]
})

describe("public doc page", () => {
  it("renders a published doc with title, body and Published date", async () => {
    const html = await renderDoc(id(1))
    expect(html).toContain("Public guide")
    expect(html).toContain("<strong>customer</strong>")
    expect(html).toContain("Published Oct 3, 2026")
    expect(html).toContain("Second guide") // sidebar lists the other published doc
  })

  it("404s for an unpublished doc and never renders its title or body", async () => {
    await expect(renderDoc(id(2))).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("404s for a doc id that belongs to another workspace (even if published there)", async () => {
    await expect(renderDoc(id(3), "alpha")).rejects.toThrow("NEXT_NOT_FOUND")
    // And it renders fine from its own workspace: the 404 above is scoping, not breakage.
    expect(await renderDoc(id(3), "beta")).toContain("BETA-BODY")
  })

  it("404s for externally stored and canvas docs even when publishedAt is set", async () => {
    await expect(renderDoc(id(4))).rejects.toThrow("NEXT_NOT_FOUND")
    await expect(renderDoc(id(5))).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("404s for malformed ids and unknown workspaces", async () => {
    await expect(renderDoc("not-a-uuid")).rejects.toThrow("NEXT_NOT_FOUND")
    await expect(renderDoc("../../etc/passwd")).rejects.toThrow("NEXT_NOT_FOUND")
    await expect(renderDoc(id(1), "nope")).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("never leaks author, editor, metadata or storage fields into the HTML", async () => {
    const html = await renderDoc(id(1))
    for (const secret of ["author-id-PRIVATE", "editor-id-PRIVATE", "owner-email-PRIVATE", "createdById", "updatedById", "contentRef", "storageProvider"]) {
      expect(html).not.toContain(secret)
    }
    // Every public read used an explicit select that excludes those columns.
    for (const call of [...prisma.doc.findFirst.mock.calls, ...prisma.doc.findMany.mock.calls]) {
      const select = (call[0] as { select: Record<string, boolean> }).select
      expect(Object.keys(select).sort()).toEqual(["content", "id", "publishedAt", "title", "updatedAt"])
    }
  })

  it("renders markdown safely: no raw HTML, scripts, javascript: links or remote images", async () => {
    rows[0].content = [
      "<script>alert('xss')</script>",
      "<img src=x onerror=alert(1)>",
      "[click](javascript:alert(1))",
      "![tracker](https://evil.example/pixel.png)",
      "<iframe src='https://evil.example'></iframe>",
      "[ok](https://example.com/page)",
    ].join("\n\n")
    const html = await renderDoc(id(1))
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<iframe/i)
    expect(html).not.toMatch(/<img/i)
    // Raw HTML is shown as inert escaped text, never as live elements or event-handler attributes.
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i)
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toMatch(/javascript:/i)
    expect(html).toContain('href="https://example.com/page"')
  })

  it("unpublish is immediate: the very next render is a 404", async () => {
    expect(await renderDoc(id(1))).toContain("Public guide")
    const result = await setDocPublished(prisma as unknown as AppPrismaClient, { userId: "member-1", docId: id(1), published: false })
    expect(result.published).toBe(false)
    await expect(renderDoc(id(1))).rejects.toThrow("NEXT_NOT_FOUND")
    expect(await renderIndex()).not.toContain("Public guide")
  })

  it("a non-member cannot publish, so the doc stays private", async () => {
    await expect(setDocPublished(prisma as unknown as AppPrismaClient, { userId: "stranger", docId: id(2), published: true })).rejects.toMatchObject({ code: "not_found" })
    await expect(renderDoc(id(2))).rejects.toThrow("NEXT_NOT_FOUND")
  })

  it("generateMetadata uses the title for a published doc and reveals nothing for an unpublished one", async () => {
    const { generateMetadata } = await import("@/app/portal/[orgSlug]/[workspaceSlug]/docs/[docId]/page")
    expect(await generateMetadata(docParams(id(1)))).toEqual({ title: "Public guide · Alpha Co" })
    const hidden = await generateMetadata(docParams(id(2)))
    expect(JSON.stringify(hidden)).not.toContain("Secret roadmap plan")
    const foreign = await generateMetadata(docParams(id(3), "alpha"))
    expect(JSON.stringify(foreign)).not.toContain("Beta only doc")
  })
})

describe("public docs index", () => {
  it("lists only this workspace's published, publishable docs", async () => {
    const html = await renderIndex()
    expect(html).toContain("Public guide")
    expect(html).toContain("Second guide")
    for (const hidden of ["Secret roadmap plan", "TOP-SECRET-DRAFT-BODY", "Beta only doc", "External doc", "Canvas doc", "author-id-PRIVATE"]) {
      expect(html).not.toContain(hidden)
    }
  })

  it("shows the empty state when nothing is published", async () => {
    rows.forEach((r) => (r.publishedAt = null))
    expect(await renderIndex()).toContain("No docs published yet")
  })

  it("404s for an unknown workspace", async () => {
    await expect(renderIndex("nope")).rejects.toThrow("NEXT_NOT_FOUND")
  })
})
