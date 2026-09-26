import { describe, expect, it } from "vitest"
import { computeCardStatus, computeDelta, formatRelative, headlineValue, humanizeErrorCode, STALE_AFTER_MS } from "./dashboard-status"
import type { ObservationData } from "./providers"

const now = new Date("2026-06-15T12:00:00Z")

function observation(overrides: Partial<ObservationData> = {}): ObservationData {
  return { value: 100, series: [], completeness: "COMPLETE", note: null, provenance: {}, ...overrides }
}

describe("headlineValue", () => {
  it("uses the aggregate value for pageviews and event_count", () => {
    expect(headlineValue({ metric: "pageviews" }, observation({ value: 42 }))).toBe(42)
    expect(headlineValue({ metric: "event_count" }, observation({ value: 7 }))).toBe(7)
  })
  it("uses the most recent day for daily_visitors, never the null aggregate", () => {
    const data = observation({ value: null, series: [{ date: "2026-06-13", value: 10 }, { date: "2026-06-14", value: 15 }] })
    expect(headlineValue({ metric: "daily_visitors" }, data)).toBe(15)
  })
  it("returns null for daily_visitors with an empty series", () => {
    expect(headlineValue({ metric: "daily_visitors" }, observation({ value: null, series: [] }))).toBeNull()
  })
})

describe("computeDelta", () => {
  it("returns null when either side is missing", () => {
    expect(computeDelta(null, 10)).toBeNull()
    expect(computeDelta(10, null)).toBeNull()
    expect(computeDelta(null, null)).toBeNull()
  })
  it("reports an increase", () => {
    expect(computeDelta(15, 10)).toEqual({ direction: "up", diff: 5 })
  })
  it("reports a decrease", () => {
    expect(computeDelta(8, 10)).toEqual({ direction: "down", diff: -2 })
  })
  it("treats no change as up (diff 0)", () => {
    expect(computeDelta(10, 10)).toEqual({ direction: "up", diff: 0 })
  })
})

describe("formatRelative", () => {
  it.each([
    [0, "just now"],
    [30_000, "just now"],
    [90_000, "2m ago"],
    [3_600_000, "1h ago"],
    [7_200_000, "2h ago"],
    [86_400_000, "1d ago"],
    [172_800_000, "2d ago"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatRelative(ms)).toBe(expected)
  })
  it("never goes negative for clock skew", () => {
    expect(formatRelative(-5000)).toBe("just now")
  })
})

describe("humanizeErrorCode", () => {
  it("maps known codes", () => {
    expect(humanizeErrorCode("AUTHENTICATION")).toBe("provider token rejected")
  })
  it("falls back for unknown codes", () => {
    expect(humanizeErrorCode("SOMETHING_NEW")).toBe("sync failed")
  })
})

describe("computeCardStatus", () => {
  it("prioritizes a failed refresh over everything else", () => {
    const result = computeCardStatus({
      hasActiveBinding: true,
      connectionHealthy: false,
      lastError: "AUTHENTICATION",
      lastAttemptAt: new Date(now.getTime() - 3_600_000),
      latestObservationAt: new Date(now.getTime() - 1000),
      now,
    })
    expect(result.status).toBe("failed")
    expect(result.caption).toBe("Sync failed 1h ago — provider token rejected")
  })
  it("does not report a disconnected provider for a metric that was never linked to anything", () => {
    const result = computeCardStatus({ hasActiveBinding: false, connectionHealthy: false, lastError: null, lastAttemptAt: null, latestObservationAt: null, now })
    expect(result).toEqual({ status: "fresh", caption: "Not yet linked to a metric binding" })
  })
  it("is failed when the connection is unhealthy even without a binding-level lastError", () => {
    const result = computeCardStatus({ hasActiveBinding: true, connectionHealthy: false, lastError: null, lastAttemptAt: null, latestObservationAt: new Date(now.getTime() - 1000), now })
    expect(result).toEqual({ status: "failed", caption: "Provider disconnected" })
  })
  it("is fresh with a distinct caption when never linked", () => {
    const result = computeCardStatus({ hasActiveBinding: false, connectionHealthy: null, lastError: null, lastAttemptAt: null, latestObservationAt: null, now })
    expect(result).toEqual({ status: "fresh", caption: "Not yet linked to a metric binding" })
  })
  it("is fresh with a distinct caption when linked but never refreshed", () => {
    const result = computeCardStatus({ hasActiveBinding: true, connectionHealthy: true, lastError: null, lastAttemptAt: null, latestObservationAt: null, now })
    expect(result).toEqual({ status: "fresh", caption: "No observations yet — refresh to collect the first snapshot" })
  })
  it("is fresh just under the staleness threshold", () => {
    const result = computeCardStatus({ hasActiveBinding: true, connectionHealthy: true, lastError: null, lastAttemptAt: null, latestObservationAt: new Date(now.getTime() - (STALE_AFTER_MS - 1000)), now })
    expect(result.status).toBe("fresh")
  })
  it("is stale just over the staleness threshold", () => {
    const result = computeCardStatus({ hasActiveBinding: true, connectionHealthy: true, lastError: null, lastAttemptAt: null, latestObservationAt: new Date(now.getTime() - (STALE_AFTER_MS + 1000)), now })
    expect(result.status).toBe("stale")
    expect(result.caption).toMatch(/^No new data for/)
  })
})
