/**
 * Wire-level vocabulary of the registered tools: list_docs (new) and write_doc's `kind`. The handler tests call the handlers directly,
 * so the registered inputSchema never runs there; these assertions pin what an agent actually sees.
 */
import { describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"

type ToolMeta = { inputSchema: Record<string, ZodType>; description?: string }
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta }, registerResource() {} })
    return () => new Response("ok")
  },
}))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }) }))

await import("@/app/api/mcp/route")

describe("list_docs registration", () => {
  it("is a registered tool", () => {
    expect(registeredTools.list_docs).toBeDefined()
  })

  it("takes workspaceId, an optional kind and a bounded optional limit", () => {
    const schema = registeredTools.list_docs.inputSchema
    expect(schema.workspaceId.safeParse("11111111-1111-4111-8111-111111111111").success).toBe(true)
    expect(schema.workspaceId.safeParse("nope").success).toBe(false)
    for (const kind of ["ADR", "QA_REPORT", "DESIGN", "NOTE"]) expect(schema.kind.safeParse(kind).success, kind).toBe(true)
    for (const kind of ["SPEC", "PLAN", "adr", ""]) expect(schema.kind.safeParse(kind).success, kind).toBe(false)
    expect(schema.kind.safeParse(undefined).success).toBe(true)
    expect(schema.limit.safeParse(undefined).success).toBe(true)
    expect(schema.limit.safeParse(200).success).toBe(true)
    expect(schema.limit.safeParse(201).success).toBe(false)
    expect(schema.limit.safeParse(0).success).toBe(false)
    expect(schema.limit.safeParse(2.5).success).toBe(false)
  })

  it("tells an agent the default and the ceiling of limit", () => {
    expect(registeredTools.list_docs.inputSchema.limit.description).toMatch(/default 50/)
    expect(registeredTools.list_docs.inputSchema.limit.description).toMatch(/200/)
  })
})

describe("write_doc kind", () => {
  it("is optional and accepts the four kinds and null (to clear), and nothing else", () => {
    const schema = registeredTools.write_doc.inputSchema
    for (const kind of ["ADR", "QA_REPORT", "DESIGN", "NOTE", null, undefined]) expect(schema.kind.safeParse(kind).success, String(kind)).toBe(true)
    for (const kind of ["SPEC", "PLAN", "DISCOVERY_PLAN", "adr", ""]) expect(schema.kind.safeParse(kind).success, kind).toBe(false)
  })

  it("never says Spec or Discovery Plan in the kind descriptions", () => {
    const text = [registeredTools.write_doc.inputSchema.kind?.description, registeredTools.list_docs?.inputSchema.kind?.description].filter(Boolean).join(" ")
    expect(text).not.toBe("")
    expect(text).not.toMatch(/\bspec\b|discovery plan/i)
  })
})
