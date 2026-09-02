import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("functional E2E baseline migrations", () => {
  it("applies migration 028 before seeding agent runtime configuration", () => {
    const setup = readFileSync(path.join(process.cwd(), "e2e/functional/global-setup.ts"), "utf8")
    const migration028 = setup.indexOf("028_agent_runtime_config/migration.sql")
    const research034 = setup.indexOf("034_research_capture/migration.sql")
    expect(migration028).toBeGreaterThan(-1)
    expect(research034).toBeGreaterThan(migration028)
  })

  it("applies precursor migrations and invokes the bounded provenance backfill before NOT NULL", () => {
    const setup = readFileSync(path.join(process.cwd(), "e2e/functional/global-setup.ts"), "utf8")
    expect(setup).toContain("039_native_decision_gates/migration.sql")
    expect(setup).toContain("040_release_authorization/migration.sql")
    expect(setup).toContain("041_portfolio_capacity_ledger/migration.sql")
    expect(setup).toContain("backfillRoadmapCommitmentProvenance")
    expect(setup.indexOf("backfillRoadmapCommitmentProvenance")).toBeLessThan(setup.indexOf("seedE2E"))
  })
})
