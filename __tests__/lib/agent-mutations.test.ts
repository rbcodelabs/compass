import { describe, it, expect } from "vitest"
import { isMutationTool, bareToolName } from "@/lib/agent-mutations"

describe("isMutationTool", () => {
  it("treats get_/list_/search_ as read-only", () => {
    for (const n of ["get_workspace_summary", "list_opportunities", "search_help", "mcp__compass__get_opportunity"]) {
      expect(isMutationTool(n)).toBe(false)
    }
  })
  it("treats everything else as a mutation", () => {
    for (const n of ["create_opportunity", "update_task", "delete_assumption", "promote_to_roadmap", "assign_squad", "mcp__compass__score_opportunity"]) {
      expect(isMutationTool(n)).toBe(true)
    }
  })
})

describe("bareToolName", () => {
  it("strips the mcp server prefix", () => {
    expect(bareToolName("mcp__compass__create_opportunity")).toBe("create_opportunity")
    expect(bareToolName("create_opportunity")).toBe("create_opportunity")
  })
})
