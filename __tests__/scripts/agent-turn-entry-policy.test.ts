import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("agent entry capability-pack policy", () => {
  it("keeps plugins declarative while Compass owns MCP and no built-ins are exposed", () => {
    const source = readFileSync("scripts/agent/turn-entry.ts", "utf8")
    expect(source).toContain("skipMcpDiscovery: true")
    expect(source).toContain("strictMcpConfig: true")
    expect(source).toMatch(/tools:\s*\[\]/)
    expect(source).toMatch(/settingSources:\s*\[\]/)
    expect(source).toContain('allowedTools: ["mcp__compass"]')
  })
})
