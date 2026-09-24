import { describe, expect, it } from "vitest"
import { TOOL_GATES, TOOL_SCOPES, AGENT_TOOL_POLICY } from "@/lib/mcp-tool-gates"

describe("analytics MCP policies", () => {
  const reads = ["list_analytics_connections", "list_metrics", "get_metric", "list_metric_bindings", "get_metric_binding", "list_metric_observations", "get_metric_observation"]
  const writes = ["create_metric", "update_metric", "archive_metric", "link_metric", "update_metric_binding", "unlink_metric", "refresh_metric_binding"]
  it.each(reads)("%s is member-scoped read", name => {
    expect(TOOL_GATES[name]).toBeTypeOf("function")
    expect(TOOL_SCOPES[name]).toBe("mcp:read")
    expect(AGENT_TOOL_POLICY[name]).toBe("READ")
  })
  it.each(writes)("%s is member-scoped write", name => {
    expect(TOOL_GATES[name]).toBeTypeOf("function")
    expect(TOOL_SCOPES[name]).toBe("mcp:write")
    expect(AGENT_TOOL_POLICY[name]).toBe("WRITE")
  })
  it("does not expose credentials over MCP", () => {
    for (const name of ["save_analytics_connection", "connect_vercel", "disconnect_analytics_connection"]) expect(TOOL_GATES[name]).toBeUndefined()
  })
})
