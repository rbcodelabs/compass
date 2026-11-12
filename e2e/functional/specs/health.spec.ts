/**
 * The liveness probe is reachable with no session at all, and
 * answers without a database. It is the one route an orchestrator needs to
 * hit before anyone can sign in, so the proxy must let it through rather than
 * redirect it to /login.
 */
import { test, expect } from "../fixtures/index"

test.describe("GET /api/health", () => {
  test("answers 200 JSON to an anonymous caller without redirecting", async ({ browser, baseURL }) => {
    // Explicitly override the functional project's authenticated storage state.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const res = await context.request.get(`${baseURL}/api/health`, { maxRedirects: 0 })
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
    expect(res.headers()["cache-control"]).toBe("no-store")
    await context.close()
  })

  test("a path under it is still behind login", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const res = await context.request.get(`${baseURL}/api/health/anything`, { maxRedirects: 0 })
    expect([301, 302, 303, 307, 308]).toContain(res.status())
    expect(res.headers()["location"] ?? "").toContain("/login")
    await context.close()
  })
})
