import { describe, expect, it } from "vitest"
import { researchFailureDiagnostic } from "@/lib/research-failure-diagnostics"

describe("safe research failure diagnostics", () => {
  it.each([
    [Object.assign(new Error("private file"), { code: "ENOENT" }), "file_not_found"],
    [Object.assign(new Error("private file"), { code: "EACCES" }), "permission_denied"],
    [Object.assign(new Error("private host"), { code: "ECONNRESET" }), "network_failure"],
    [Object.assign(new Error("secret"), { status: 401 }), "authentication_failed"],
    [Object.assign(new Error("secret"), { statusCode: 429 }), "rate_limited"],
    [new Error("Research analysis deadline exceeded"), "deadline_exceeded"],
    [new Error("Agent runtime is not initialized"), "configuration_missing"],
    [new Error("prompt is too long: secret"), "context_limit"],
    [new SyntaxError("private generated JSON"), "invalid_output"],
    [new Error("Research query ended with subtype: error_max_turns"), "max_turns"],
    [new Error("Research query ended with subtype: error_during_execution"), "provider_execution_failed"],
    [new Error("unknown private payload"), "unexpected_failure"],
  ])("maps failure to a fixed category without emitting source content", (error, category) => {
    const result = researchFailureDiagnostic(error)
    expect(result.category).toBe(category)
    expect(Object.keys(result).every(key => ["category", "status"].includes(key))).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/secret|private|payload/)
  })
})
