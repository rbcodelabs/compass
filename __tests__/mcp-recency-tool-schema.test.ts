/**
 * Schema-level coverage for the recency filters and the recency sort across
 * every list tool that exposes them.
 *
 * Registration is where the contract lives: the handler tests invoke the tool
 * callback directly, so the registered inputSchema never runs there. These
 * assertions pin the wire-level vocabulary agents actually see, and guard
 * against the six tools drifting apart one edit at a time.
 */
import { describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"

type ToolMeta = { inputSchema: Record<string, ZodType> }
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta } })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

/** Every tool that gained a recency window and/or a recency sort. */
const WINDOW_TOOLS = [
  "list_opportunities",
  "list_solutions",
  "list_assumptions",
  "list_roadmap_items",
  "list_docs",
] as const

/** list_tasks already had the window; it gained only the sort. */
const SORT_TOOLS = [...WINDOW_TOOLS, "list_tasks"] as const

describe.each(WINDOW_TOOLS)("%s recency window", (tool) => {
  it("accepts ISO timestamps and rejects prose on both bounds", () => {
    const schema = registeredTools[tool].inputSchema
    expect(schema.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect(schema.updatedBefore.safeParse("2026-09-07T00:00:00.000Z").success).toBe(true)
    expect(schema.updatedSince.safeParse("recently").success).toBe(false)
    expect(schema.updatedBefore.safeParse("last tuesday").success).toBe(false)
    // A bare date is not a timestamp — .datetime() must keep rejecting it so the
    // tool never silently reads it as midnight UTC.
    expect(schema.updatedSince.safeParse("2026-09-01").success).toBe(false)
  })

  it("leaves both bounds optional so existing callers are unaffected", () => {
    const schema = registeredTools[tool].inputSchema
    expect(schema.updatedSince.safeParse(undefined).success).toBe(true)
    expect(schema.updatedBefore.safeParse(undefined).success).toBe(true)
  })
})

describe.each(SORT_TOOLS)("%s recency sort", (tool) => {
  it("accepts exactly the two shared recency sort values", () => {
    const schema = registeredTools[tool].inputSchema
    expect(schema.sort.safeParse("recentlyUpdated").success).toBe(true)
    expect(schema.sort.safeParse("leastRecentlyUpdated").success).toBe(true)
    expect(schema.sort.safeParse("alphabetical").success).toBe(false)
    expect(schema.sort.safeParse("updatedAt").success).toBe(false)
    expect(schema.sort.safeParse("desc").success).toBe(false)
  })

  it("is optional, so omitting it keeps the tool's default ordering", () => {
    expect(registeredTools[tool].inputSchema.sort.safeParse(undefined).success).toBe(true)
  })

  it("describes itself so an agent knows omitting it preserves the default order", () => {
    expect(registeredTools[tool].inputSchema.sort.description).toContain("default ordering")
  })
})

describe("list_opportunities keyset pagination inputs", () => {
  it("bounds limit to a sane page size and keeps it optional", () => {
    const schema = registeredTools.list_opportunities.inputSchema
    expect(schema.limit.safeParse(undefined).success).toBe(true)
    expect(schema.limit.safeParse(1).success).toBe(true)
    expect(schema.limit.safeParse(200).success).toBe(true)
    // The ceiling is the whole point: `limit` must not be usable to restore the
    // unbounded response this change exists to remove.
    expect(schema.limit.safeParse(201).success).toBe(false)
    expect(schema.limit.safeParse(0).success).toBe(false)
    expect(schema.limit.safeParse(-5).success).toBe(false)
    expect(schema.limit.safeParse(25.5).success).toBe(false)
  })

  it("accepts an opaque string cursor and keeps it optional", () => {
    const schema = registeredTools.list_opportunities.inputSchema
    expect(schema.cursor.safeParse(undefined).success).toBe(true)
    expect(schema.cursor.safeParse("eyJ2IjoxfQ").success).toBe(true)
    expect(schema.cursor.safeParse(42).success).toBe(false)
  })

  it("tells the caller in the descriptions how to page and what to repeat", () => {
    const schema = registeredTools.list_opportunities.inputSchema
    // An agent only ever sees these strings, so they carry the protocol.
    expect(schema.limit.description).toContain("default 50")
    expect(schema.cursor.description).toContain("nextCursor")
    expect(schema.cursor.description).toContain("same filters and sort")
  })

  it("announces in the tool description that results are paginated", () => {
    const meta = registeredTools.list_opportunities as ToolMeta & { description?: string }
    expect(meta.description).toMatch(/paginated/i)
  })
})

describe("list_experiments is deliberately left alone", () => {
  it("keeps its bespoke updatedSince + endBefore pair and gains no sort", () => {
    const schema = registeredTools.list_experiments.inputSchema
    // Its updatedSince also matches newly logged results, and it is already
    // hard-sorted by updatedAt desc, so there is nothing for `sort` to select.
    expect(schema.updatedSince.safeParse("2026-09-01T00:00:00.000Z").success).toBe(true)
    expect("endBefore" in schema).toBe(true)
    expect("sort" in schema).toBe(false)
  })
})
