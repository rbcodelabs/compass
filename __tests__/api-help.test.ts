import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ auth: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))

import { GET } from "@/app/api/help/route"
import { getAllDocs } from "@/lib/docs"

const get = (qs = "") => GET(new Request(`http://localhost/api/help${qs}`))

describe("GET /api/help", () => {
  beforeEach(() => {
    mocks.auth.mockReset()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
  })

  it("rejects anonymous callers", async () => {
    mocks.auth.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(res.headers.get("Cache-Control")).toBe("private, no-store")
  })

  it("lists every guide when called with no params", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { topics: { slug: string }[] }
    expect(body.topics.map((t) => t.slug)).toEqual(getAllDocs().map((d) => d.slug))
    expect(body.topics.length).toBeGreaterThan(0)
  })

  it("returns rendered HTML for a known slug", async () => {
    const [first] = getAllDocs()
    const res = await get(`?slug=${first.slug}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { doc: { slug: string; html: string } }
    expect(body.doc.slug).toBe(first.slug)
    expect(body.doc.html.length).toBeGreaterThan(0)
  })

  it("404s an unknown slug and 400s one that could leave docs/content", async () => {
    expect((await get("?slug=does-not-exist")).status).toBe(404)
    expect((await get(`?slug=${encodeURIComponent("../package")}`)).status).toBe(400)
    expect((await get(`?slug=${encodeURIComponent("a/b")}`)).status).toBe(400)
  })

  it("searches, and returns no results for a blank query", async () => {
    const found = (await (await get("?q=roadmap")).json()) as { results: { slug: string }[] }
    expect(found.results.length).toBeGreaterThan(0)
    expect(found.results.length).toBeLessThanOrEqual(8)

    const blank = (await (await get("?q=%20%20")).json()) as { results: unknown[] }
    expect(blank.results).toEqual([])
  })
})
