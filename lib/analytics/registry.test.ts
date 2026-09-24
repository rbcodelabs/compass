import { describe, expect, it, vi } from "vitest"
import { ANALYTICS_PROVIDERS, effectiveObservationWindow } from "./registry"
describe("compiled analytics adapter contract", () => {
  it("advances native followup snapshots across UTC days without inventing a historical baseline", () => {
    const logical = { since: "2026-01-01", until: "2026-01-30" }
    expect(effectiveObservationWindow("compass_activation", "FOLLOWUP", logical, new Date("2026-03-01T12:00:00Z"))).toEqual({ since: "2026-01-31", until: "2026-03-01" })
    expect(effectiveObservationWindow("compass_activation", "FOLLOWUP", logical, new Date("2026-03-02T12:00:00Z"))).toEqual({ since: "2026-02-01", until: "2026-03-02" })
    expect(effectiveObservationWindow("compass_activation", "BASELINE", logical, new Date("2026-03-02T12:00:00Z"))).toEqual(logical)
    expect(effectiveObservationWindow("vercel", "FOLLOWUP", logical, new Date("2026-03-02T12:00:00Z"))).toEqual(logical)
  })
  it("gives each provider validation, typed capabilities, and normalized fetch", async () => {
    for (const provider of Object.values(ANALYTICS_PROVIDERS)) {
      expect(provider.validate).toBeTypeOf("function")
      expect(provider.fetch).toBeTypeOf("function")
      expect(provider.capabilities.windowMode).toMatch(/calendar|current_snapshot/)
    }
    const native = await ANALYTICS_PROVIDERS.compass_activation.fetch({ query: { metric: "active_discovery_teams" }, window: { since: "2026-01-31", until: "2026-03-01" }, activation: { count: vi.fn().mockResolvedValue(2), now: new Date("2026-03-01T12:00:00Z"), epoch: "2026-01-01T00:00:00Z" } })
    expect(native.value).toBe(2)
    expect(native.completeness).toBe("COMPLETE")
  })
})
