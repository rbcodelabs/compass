import { describe, it, expect } from "vitest"
import { humanizeToolName } from "@/lib/agent-tools"

describe("humanizeToolName", () => {
  it("strips the mcp server prefix and humanizes snake_case", () => {
    expect(humanizeToolName("mcp__compass__list_top_opportunities")).toBe("List top opportunities")
    expect(humanizeToolName("mcp__compass__get_workspace_summary")).toBe("Get workspace summary")
  })
  it("handles bare tool names (no prefix)", () => {
    expect(humanizeToolName("create_opportunity")).toBe("Create opportunity")
  })
  it("is stable on already-clean input", () => {
    expect(humanizeToolName("search")).toBe("Search")
  })
})
