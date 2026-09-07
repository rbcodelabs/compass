import { describe, expect, it, vi } from "vitest"
import { provisioningStatements, cleanupEligible, migrateToReady } from "../scripts/preview-automation/database"
describe("preview database lifecycle", () => {
  it("grants runtime only DML within the exact schema", () => {
    const statements = provisioningStatements("compass_pr_1_aaaaaaaaaaaa", "arn:aws:iam::123456789012:role/preview-runtime", "arn:aws:iam::123456789012:role/preview-migrate")
    expect(statements.join("\n")).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "compass_pr_1_aaaaaaaaaaaa"')
    expect(statements.join("\n")).not.toContain("compass_prod")
    expect(() => provisioningStatements("compass_prod", "bad", "bad")).toThrow()
  })
  it("will not remove live schemas even when PR is closed", () => {
    expect(cleanupEligible({ registered: true, activeRuns: 1, closed: true, lastActivity: 0 }, 999999999)).toBe(false)
    expect(cleanupEligible({ registered: false, activeRuns: 0, closed: true, lastActivity: 0 }, 999999999)).toBe(false)
    expect(cleanupEligible({ registered: true, activeRuns: 0, closed: true, lastActivity: 0 }, 999999999)).toBe(true)
  })
  it("resumes 202 migrations and fails closed on exhaustion", async () => {
    const apply = vi.fn().mockResolvedValueOnce(202).mockResolvedValue(200)
    const status = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    await migrateToReady(apply, status, async () => {}, 3)
    expect(apply).toHaveBeenCalledTimes(3)
    await expect(migrateToReady(async () => 202, async () => false, async () => {}, 2)).rejects.toThrow("did not become ready")
  })
})
