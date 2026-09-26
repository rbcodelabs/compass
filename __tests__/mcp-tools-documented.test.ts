import fs from "fs"
import path from "path"
import { describe, expect, it, vi } from "vitest"

// Captures every tool the MCP route registers, so docs cannot drift from the code by omission.
const tools: Record<string, unknown> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: unknown) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool: (name, meta) => { tools[name] = meta }, registerResource: () => {} })
    return vi.fn()
  },
}))

await import("@/app/api/mcp/route")

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf-8")

/** A tool counts as documented when its name appears as inline code, bare (`tool_name`) or called (`tool_name({ ... })`). */
const mentions = (markdown: string, name: string) => markdown.includes(`\`${name}\``) || markdown.includes(`\`${name}(`)

/** The typed-link tools carry subtle semantics, so the plugin skill catalog is pinned for them specifically. */
const TYPED_LINK_TOOLS = [
  "link_opportunity_to_objective",
  "unlink_opportunity_from_objective",
  "link_solution_to_key_result",
  "unlink_solution_from_key_result",
  "list_links",
]

describe("MCP tools are documented", () => {
  const registered = Object.keys(tools).sort()

  it("registers tools (guards against the mock silently capturing nothing)", () => {
    expect(registered.length).toBeGreaterThan(100)
  })

  it("mentions every registered tool in docs/content/09-mcp-api.md", () => {
    const markdown = read("docs/content/09-mcp-api.md")
    expect(registered.filter((name) => !mentions(markdown, name))).toEqual([])
  })

  it("mentions every typed-link tool in the compass plugin skill catalog", () => {
    const markdown = read("plugins/compass/skills/compass/SKILL.md")
    expect(TYPED_LINK_TOOLS.filter((name) => !registered.includes(name))).toEqual([])
    expect(TYPED_LINK_TOOLS.filter((name) => !mentions(markdown, name))).toEqual([])
  })
})
