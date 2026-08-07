import { describe, it, expect } from "vitest"
import { sandboxPackageJson, computeDepsFingerprint, SANDBOX_DEPENDENCIES } from "@/lib/agent-sandbox"

describe("sandboxPackageJson", () => {
  it("is valid JSON declaring exactly the sandbox dependency set", () => {
    const pkg = JSON.parse(sandboxPackageJson())
    expect(pkg.type).toBe("module")
    expect(pkg.dependencies).toEqual(SANDBOX_DEPENDENCIES)
    expect(Object.keys(pkg.dependencies)).toContain("@anthropic-ai/claude-agent-sdk")
    expect(Object.keys(pkg.dependencies)).toContain("@modelcontextprotocol/sdk")
  })
})

describe("computeDepsFingerprint", () => {
  it("is a deterministic 64-char sha256 hex of the deps package.json", () => {
    const a = computeDepsFingerprint()
    const b = computeDepsFingerprint()
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
