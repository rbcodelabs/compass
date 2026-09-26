import { describe, expect, it, vi } from "vitest"
import { fetchActivationObservation } from "./activation"
describe("prospective team activation", () => {
  it("refuses inferred history", async () => {
    const result = await fetchActivationObservation({ since: "2026-01-01", until: "2026-01-30" }, vi.fn(), new Date("2026-03-01T12:00:00Z"), "2026-01-01T00:00:00Z")
    expect(result.completeness).toBe("UNAVAILABLE")
    expect(result.value).toBeNull()
  })
  it("keeps a zero during warmup partial and uses exact thirty-day boundary", async () => {
    const count = vi.fn().mockResolvedValue(0)
    const result = await fetchActivationObservation({ since: "2026-01-31", until: "2026-03-01" }, count, new Date("2026-03-01T12:00:00Z"), "2026-02-15T00:00:00Z")
    expect(result.completeness).toBe("PARTIAL")
    expect(result.value).toBe(0)
    expect(count).toHaveBeenCalledWith(new Date("2026-01-30T12:00:00Z"), new Date("2026-03-01T12:00:00Z"))
  })
})
