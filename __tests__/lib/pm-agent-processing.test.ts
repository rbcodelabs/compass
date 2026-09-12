import { describe, expect, it } from "vitest"
import { processingStatus, assertInterviewToolInput } from "@/lib/pm-agent-processing"

describe("interview core-agent handoff", () => {
  it("keeps a committed receipt successful after a worker failure", () => {
    expect(processingStatus({ status: "FAILED", receipt: { changedFields: ["title"], targetUrl: "/item" } }, Date.now())).toBe("SUCCEEDED")
  })
  it("exposes expired running work as interrupted", () => {
    expect(processingStatus({ status: "RUNNING", deadline: 10 }, 11)).toBe("INTERRUPTED")
  })
  it("rejects lifecycle fields rather than silently ignoring them", () => {
    expect(() => assertInterviewToolInput("ASSUMPTION", "a", "update_assumption", { assumptionId: "a", title: "Clarified", status: "VALIDATED" })).toThrow(/field/i)
  })
  it("rejects another target or tool", () => {
    expect(() => assertInterviewToolInput("SOLUTION", "a", "update_solution", { solutionId: "b", title: "Other" })).toThrow()
    expect(() => assertInterviewToolInput("SOLUTION", "a", "add_evidence", {})).toThrow()
  })
  it("accepts a version-fenced descriptive edit", () => {
    expect(() => assertInterviewToolInput("OPPORTUNITY", "a", "update_opportunity", { opportunityId: "a", description: "Clarified", expectedUpdatedAt: "2026-09-12T00:00:00.000Z" })).not.toThrow()
  })
})
