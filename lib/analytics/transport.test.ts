import { afterEach, describe, expect, it, vi } from "vitest"
import { analyticsFetch, analyticsFixtureEnabled, validateVercelProject } from "./transport"
afterEach(() => vi.unstubAllEnvs())
describe("analytics transport", () => {
  it("fails closed for fixture mode outside the isolated local test database", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("E2E_ISOLATED_DATABASE", "1"); vi.stubEnv("DATABASE_URL", "postgresql://localhost/compass_e2e")
    expect(analyticsFixtureEnabled()).toBe(false)
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("DATABASE_URL", "postgresql://remote.example/compass_e2e")
    expect(analyticsFixtureEnabled()).toBe(false)
  })
  it("returns synthetic daily buckets only under all isolation guards", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("E2E_ISOLATED_DATABASE", "1"); vi.stubEnv("DATABASE_URL", "postgresql://localhost:5437/compass_e2e")
    const result = await analyticsFetch(new URL("https://api.vercel.com/v1/query/web-analytics/visits/aggregate?projectId=prj_compass_e2e&since=2026-01-01&until=2026-01-01"))
    expect(await result.json()).toEqual({ data: [{ timestamp: "2026-01-01T00:00:00.000Z", pageviews: 12, visitors: 7, count: 4 }] })
  })
  it("requires enabled web analytics instead of treating inaccessible collection as zero", async () => {
    await expect(validateVercelProject({ projectId: "p", token: "s" }, vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "p", webAnalytics: { enabledAt: 100, disabledAt: 200 } }))))).rejects.toThrow("ANALYTICS_DISABLED")
  })
  it("matches the Vercel SDK optional parser accepting null unused timestamps", async () => {
    await expect(validateVercelProject({ projectId: "p", token: "s" }, vi.fn().mockResolvedValue(Response.json({ id: "p", webAnalytics: { id: "wa_fixture", enabledAt: 100, disabledAt: null, canceledAt: null } })))).resolves.toBeUndefined()
    await expect(validateVercelProject({ projectId: "p", token: "s" }, vi.fn().mockResolvedValue(Response.json({ id: "p", webAnalytics: { id: "wa_fixture", enabledAt: null, disabledAt: null, canceledAt: null } })))).rejects.toThrow("ANALYTICS_DISABLED")
  })
})
