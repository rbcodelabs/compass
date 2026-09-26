import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const track = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("@vercel/analytics/server", () => ({ track }))
import { telemetrySignature, sendActivityEvent, TELEMETRY_PATH } from "@/lib/analytics/telemetry"
import { POST } from "@/app/api/analytics/activity/route"
import { isPublicPath } from "@/lib/route-access"

describe("signed privacy-safe server telemetry", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "compass.example")
    vi.stubEnv("ANALYTICS_SECRET_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"))
    vi.clearAllMocks()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  function request(body = JSON.stringify({ action: "result_recorded", source: "ui" }), timestamp = String(Date.now()), suffix = "") {
    return new Request("https://compass.example" + TELEMETRY_PATH + suffix, { method: "POST", headers: { "x-activity-timestamp": timestamp, "x-activity-signature": telemetrySignature(body, timestamp)!, cookie: "secret=session", referer: "https://compass.example/private?token=abc" }, body })
  }
  it("emits only allowlisted action/source with clean SDK headers", async () => {
    expect((await POST(request())).status).toBe(204)
    expect(track).toHaveBeenCalledWith("compass_activity", { action: "result_recorded", source: "ui" }, { headers: { "user-agent": "Compass-Activity-Relay", referer: "https://compass.example/api/analytics/activity" } })
  })
  it("rejects forged/expired signatures and preview traffic", async () => {
    const forged = request(); forged.headers.set("x-activity-signature", "0".repeat(64))
    expect((await POST(forged)).status).toBe(401)
    expect((await POST(request(undefined, String(Date.now() - 61_000)))).status).toBe(401)
    vi.stubEnv("VERCEL_ENV", "preview")
    expect((await POST(request())).status).toBe(401)
    expect(track).not.toHaveBeenCalled()
  })
  it("rejects query-bearing/path-variant requests, extra properties and oversized bodies", async () => {
    expect((await POST(request(undefined, undefined, "?token=private"))).status).toBe(404)
    expect((await POST(request(undefined, undefined, "/"))).status).toBe(404)
    expect((await POST(request(JSON.stringify({ action: "result_recorded", source: "ui", workspaceId: "private" })))).status).toBe(400)
    expect((await POST(request("x".repeat(513)))).status).toBe(413)
    expect(track).not.toHaveBeenCalled()
  })
  it("sends fixed URL and signature without caller headers or identifiers", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal("fetch", fetcher)
    await sendActivityEvent({ action: "result_recorded", source: "agent" })
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe("https://compass.example/api/analytics/activity")
    expect(Object.keys(options.headers).sort()).toEqual(["content-type", "x-activity-signature", "x-activity-timestamp"])
    expect(JSON.parse(options.body)).toEqual({ action: "result_recorded", source: "agent" })
    expect(options.redirect).toBe("error")
  })
  it("fails closed without trusted config and never throws on transport failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("down")); vi.stubGlobal("fetch", fetcher)
    await expect(sendActivityEvent({ action: "result_recorded", source: "ui" })).resolves.toBeUndefined()
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "evil.example/path")
    fetcher.mockClear()
    await sendActivityEvent({ action: "result_recorded", source: "ui" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("bypasses browser login only for the exact signed route", () => {
    expect(isPublicPath(TELEMETRY_PATH)).toBe(true)
    expect(isPublicPath(TELEMETRY_PATH + "/admin")).toBe(false)
  })
})
