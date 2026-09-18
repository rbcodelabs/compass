import { describe, expect, it, vi } from "vitest"
import type { ZodType } from "zod"
type Meta = { inputSchema: Record<string, ZodType>; outputSchema: unknown }
const tools: Record<string, Meta> = {}
vi.mock("mcp-handler", () => ({ createMcpHandler: (setup: (server: { registerTool: (name: string, meta: Meta) => void }) => void) => { setup({ registerTool(name, meta) { tools[name] = meta } }); return () => new Response("ok") } }))
vi.mock("@/lib/mcp-auth", () => ({ validateMcpAuth: vi.fn() }))
await import("@/app/api/mcp/route")
import { applyToolGate, RESEARCH_TOOL_ALLOWLIST } from "@/lib/mcp-tool-gates"
const names = ["generate_research_guide", "create_research_study", "list_research_studies", "get_research_study", "update_research_study", "activate_research_study", "close_research_study", "archive_research_study", "issue_research_link", "rotate_research_link", "revoke_research_links", "list_research_sessions", "get_research_session"]
describe("research tool registration", () => {
  it.each(names)("registers %s with declared output and denies participant research credentials", async name => {
    expect(tools[name]?.outputSchema).toBeDefined()
    await expect(applyToolGate(name, { userId: "participant", purpose: "RESEARCH" }, {})).rejects.toThrow(/research interviews/)
    expect(RESEARCH_TOOL_ALLOWLIST.size).toBe(0)
  })
  it("bounds authoring and cursor input without exposing private-data options", () => {
    const create = tools.create_research_study.inputSchema
    expect(create.name.safeParse("x".repeat(256)).success).toBe(false)
    expect(create.guide.safeParse(Array(21).fill("Question")).success).toBe(false)
    expect(create.targetMinutes.safeParse(999).success).toBe(false)
    expect(create.status.safeParse("DRAFT").success).toBe(true)
    expect(create.status.safeParse("ACTIVE").success).toBe(true)
    expect(create.status.safeParse("CLOSED").success).toBe(false)
    expect(create.status.safeParse(undefined).data).toBe("ACTIVE")
    const list = tools.list_research_studies.inputSchema
    expect(list.limit.safeParse(101).success).toBe(false)
    expect(list.cursor.safeParse("x".repeat(1025)).success).toBe(false)
    expect(Object.keys(tools.get_research_study.inputSchema)).toEqual(["workspaceId", "studyId"])
  })
  it("bounds transcript reads to a study-scoped, paged input surface", () => {
    const list = tools.list_research_sessions.inputSchema
    expect(Object.keys(list).sort()).toEqual(["offset", "status", "studyId", "workspaceId"])
    expect(list.status.safeParse("NOT_A_STATUS").success).toBe(false)
    expect(list.offset.safeParse(-1).success).toBe(false)
    expect(list.offset.safeParse(1.5).success).toBe(false)
    const get = tools.get_research_session.inputSchema
    expect(Object.keys(get).sort()).toEqual(["offset", "sessionId", "studyId", "workspaceId"])
    expect(get.sessionId.safeParse("not-a-uuid").success).toBe(false)
    expect(get.offset.safeParse(-1).success).toBe(false)
  })
})
