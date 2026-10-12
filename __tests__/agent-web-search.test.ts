import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("ai", () => ({ gateway: { tools: { perplexitySearch: vi.fn() } }, generateText: vi.fn(), stepCountIs: vi.fn() }))

import {
  MAX_SEARCHES_PER_TURN,
  MAX_SNIPPET_CHARS,
  claimSearchSlot,
  clampMaxResults,
  formatSearchOutcome,
  resetAgentWebSearchesAvailabilityCache,
  runWebSearch,
  shapeResults,
  type SearchBackend,
} from "@/lib/agent-web-search"

const scope = { credentialId: "11111111-1111-4111-8111-111111111111", userId: "u", workspaceId: "w", conversationId: null }

/** In-memory stand-in honouring the composite primary key. */
function fakePrisma(options: { missingTable?: boolean } = {}) {
  const rows = new Map<string, { seq: number; status: string; resultCount: number; resultUrls: string[]; query: string }>()
  const table = {
    findFirst: vi.fn(async (args: { where?: { credentialId: string } }) => {
      if (options.missingTable) throw Object.assign(new Error("missing"), { code: "P2021" })
      if (!args.where) return null
      const seqs = [...rows.values()].map(r => r.seq)
      return seqs.length ? { seq: Math.max(...seqs) } : null
    }),
    create: vi.fn(async ({ data }: { data: { credentialId: string; seq: number; query: string } }) => {
      const key = `${data.credentialId}:${data.seq}`
      if (rows.has(key)) throw Object.assign(new Error("dup"), { code: "P2002" })
      rows.set(key, { seq: data.seq, status: "STARTED", resultCount: 0, resultUrls: [], query: data.query })
    }),
    update: vi.fn(async ({ where, data }: { where: { credentialId_seq: { credentialId: string; seq: number } }; data: Record<string, unknown> }) => {
      const row = rows.get(`${where.credentialId_seq.credentialId}:${where.credentialId_seq.seq}`)!
      Object.assign(row, data)
    }),
  }
  return { prisma: { agentWebSearch: table } as never, rows, table }
}

const ok = (n: number): SearchBackend => async () => ({
  ok: true,
  results: Array.from({ length: n }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, snippet: "s" })),
})

beforeEach(() => resetAgentWebSearchesAvailabilityCache())

describe("shapeResults", () => {
  it("drops non-http(s) URLs and malformed items, truncates, and caps the count", () => {
    const long = "x".repeat(MAX_SNIPPET_CHARS + 500)
    const shaped = shapeResults(
      [
        { title: "a", url: "https://a.test/", snippet: long, date: "2026-01-01" },
        { title: "js", url: "javascript:alert(1)", snippet: "no" },
        { title: "file", url: "file:///etc/passwd", snippet: "no" },
        "junk",
        null,
        { url: "https://b.test/" },
        { title: "c", url: "http://c.test/" },
      ],
      2,
    )
    expect(shaped.map(r => r.url)).toEqual(["https://a.test/", "https://b.test/"])
    expect(shaped[0].snippet).toHaveLength(MAX_SNIPPET_CHARS)
    expect(shaped[1].title).toBe("https://b.test/")
  })

  it("returns [] for a non-array", () => {
    expect(shapeResults(undefined, 5)).toEqual([])
  })
})

describe("clampMaxResults", () => {
  it("defaults and clamps", () => {
    expect(clampMaxResults(undefined)).toBe(5)
    expect(clampMaxResults(0)).toBe(1)
    expect(clampMaxResults(99)).toBe(8)
    expect(clampMaxResults(3.9)).toBe(3)
  })
})

describe("claimSearchSlot", () => {
  it("hands out consecutive slots and then refuses", async () => {
    const { prisma } = fakePrisma()
    for (let i = 1; i <= MAX_SEARCHES_PER_TURN; i++) expect((await claimSearchSlot(prisma, scope, "q"))?.seq).toBe(i)
    expect(await claimSearchSlot(prisma, scope, "q")).toBeNull()
  })

  it("retries when it loses a race for the same slot", async () => {
    const { prisma, table } = fakePrisma()
    // Both callers read "no rows", both try seq 1: the second insert must retry at seq 2.
    const realFind = table.findFirst.getMockImplementation()!
    let stale = 2
    table.findFirst.mockImplementation(async (args: { where?: { credentialId: string } }) => (stale-- > 0 ? null : realFind(args)))
    const [a, b] = await Promise.all([claimSearchSlot(prisma, scope, "a"), claimSearchSlot(prisma, scope, "b")])
    expect([a?.seq, b?.seq].sort()).toEqual([1, 2])
  })

  it("rethrows errors that are not a unique violation", async () => {
    const { prisma, table } = fakePrisma()
    table.create.mockRejectedValueOnce(new Error("boom"))
    await expect(claimSearchSlot(prisma, scope, "q")).rejects.toThrow("boom")
  })
})

describe("runWebSearch", () => {
  it("audits a successful search with URLs only and reports what is left", async () => {
    const { prisma, rows } = fakePrisma()
    const outcome = await runWebSearch(prisma, scope, { query: "  hello  " }, ok(2))
    expect(outcome).toMatchObject({ status: "ok", remaining: MAX_SEARCHES_PER_TURN - 1 })
    const row = [...rows.values()][0]
    expect(row).toMatchObject({ status: "SUCCEEDED", resultCount: 2, query: "hello" })
    expect(row.resultUrls).toEqual(["https://example.com/0", "https://example.com/1"])
  })

  it("stops after the per-turn budget and never calls the backend again", async () => {
    const { prisma } = fakePrisma()
    const backend = vi.fn(ok(1))
    for (let i = 0; i < MAX_SEARCHES_PER_TURN; i++) await runWebSearch(prisma, scope, { query: "q" }, backend)
    expect(await runWebSearch(prisma, scope, { query: "q" }, backend)).toEqual({ status: "budget_exhausted" })
    expect(backend).toHaveBeenCalledTimes(MAX_SEARCHES_PER_TURN)
  })

  it("still charges the budget and records FAILED when the backend fails", async () => {
    const { prisma, rows } = fakePrisma()
    const outcome = await runWebSearch(prisma, scope, { query: "q" }, async () => ({ ok: false, reason: "rate_limit" }))
    expect(outcome).toEqual({ status: "failed", reason: "rate_limit" })
    expect([...rows.values()][0].status).toBe("FAILED")
  })

  it("fails closed, without calling the backend, when the table is missing", async () => {
    const { prisma } = fakePrisma({ missingTable: true })
    const backend = vi.fn(ok(1))
    expect(await runWebSearch(prisma, scope, { query: "q" }, backend)).toEqual({ status: "unavailable" })
    expect(backend).not.toHaveBeenCalled()
  })

  it("rejects an empty query without spending a slot", async () => {
    const { prisma, rows } = fakePrisma()
    expect(await runWebSearch(prisma, scope, { query: "   " }, ok(1))).toEqual({ status: "failed", reason: "invalid_input" })
    expect(rows.size).toBe(0)
  })
})

describe("formatSearchOutcome", () => {
  it("frames results as untrusted and includes the URL", () => {
    const { text, isError } = formatSearchOutcome({
      status: "ok",
      remaining: 3,
      results: [{ title: "T", url: "https://e.test/", snippet: "line1\nline2" }],
    })
    expect(isError).toBe(false)
    expect(text).toContain("untrusted third-party content")
    expect(text).toContain("https://e.test/")
    expect(text).toContain("line1 line2")
    expect(text).toContain("3 web searches remaining")
  })

  it("marks exhausted/unavailable/failed as errors the agent can act on", () => {
    for (const outcome of [
      { status: "budget_exhausted" as const },
      { status: "unavailable" as const },
      { status: "failed" as const, reason: "timeout" as const },
    ])
      expect(formatSearchOutcome(outcome).isError).toBe(true)
  })
})
