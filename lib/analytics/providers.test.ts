import { describe, expect, it, vi } from "vitest"
import { buildVercelUrl, fetchVercelObservation, validateQuery, validateWindow } from "./providers"

describe("analytics provider contract", () => {
  it("rejects invalid calendar dates and excessive ranges", () => {
    expect(() => validateWindow({ since: "2026-02-30", until: "2026-03-01" })).toThrow()
    expect(() => validateWindow({ since: "2025-01-01", until: "2026-01-01" })).toThrow()
  })
  it("escapes filter values without accepting raw expressions", () => {
    const url = buildVercelUrl({ projectId: "prj_test", token: "secret" }, { metric: "event_count", eventName: "it's saved", eventProperties: { source: "UI" } }, { since: "2026-01-01", until: "2026-01-02" })
    expect(url.origin).toBe("https://api.vercel.com")
    expect(url.searchParams.get("filter")).toBe("eventName eq 'it''s saved' and eventData/source eq 'UI'")
    expect(url.searchParams.get("environment")).toBe("production")
    expect(() => validateQuery("vercel", { metric: "event_count", eventName: "saved", eventProperties: { "bad/key": "x" } })).toThrow()
  })
  it("never reports a sum of daily visitors as unique users", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ timestamp: "2026-01-01T00:00:00.000Z", visitors: 5 }, { timestamp: "2026-01-02T00:00:00.000Z", visitors: 7 }] })))
    const result = await fetchVercelObservation({ projectId: "prj_test", token: "secret" }, { metric: "daily_visitors" }, { since: "2026-01-01", until: "2026-01-02" }, fetcher)
    expect(result.value).toBeNull()
    expect(result.series.map(p => p.value)).toEqual([5, 7])
  })
  it("distinguishes true zero from provider failure and redacts response bodies", async () => {
    const connection = { projectId: "prj_test", token: "secret" }
    const window = { since: "2026-01-01", until: "2026-01-01" }
    const zero = await fetchVercelObservation(connection, { metric: "pageviews" }, window, vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ timestamp: "2026-01-01T00:00:00.000Z", pageviews: 0 }] }))))
    expect(zero.value).toBe(0)
    await expect(fetchVercelObservation(connection, { metric: "pageviews" }, window, vi.fn().mockResolvedValue(new Response("secret", { status: 401 })))).rejects.toThrow("AUTHENTICATION")
  })
  it("does not invent zero activity from missing or future buckets", async () => {
    const empty = await fetchVercelObservation({ projectId: "p", token: "s" }, { metric: "pageviews" }, { since: "2026-01-01", until: "2026-01-02" }, vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }))))
    expect(empty.value).toBeNull()
    expect(empty.completeness).toBe("UNAVAILABLE")
    expect(empty.series).toEqual([])
  })
  it("rejects malformed and truncated results instead of silently coercing to zero", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ timestamp: "Others", pageviews: 3 }] })))
    await expect(fetchVercelObservation({ projectId: "p", token: "s" }, { metric: "pageviews" }, { since: "2026-01-01", until: "2026-01-01" }, fetcher)).rejects.toThrow("INVALID_RESPONSE")
  })
  it("does not emit an inexact scalar when safe daily counts overflow in aggregate", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ timestamp: "2026-01-01T00:00:00.000Z", pageviews: Number.MAX_SAFE_INTEGER }, { timestamp: "2026-01-02T00:00:00.000Z", pageviews: Number.MAX_SAFE_INTEGER }] })))
    await expect(fetchVercelObservation({ projectId: "p", token: "s" }, { metric: "pageviews" }, { since: "2026-01-01", until: "2026-01-02" }, fetcher)).rejects.toThrow("INVALID_RESPONSE")
  })
})
