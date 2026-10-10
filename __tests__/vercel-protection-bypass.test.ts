import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isAutoBypassConfigured, leaseProtectionBypass, VercelBypassError } from "@/lib/vercel-protection-bypass"

const fetchMock = vi.fn()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  vi.stubEnv("VERCEL_ACCESS_TOKEN", "tok_test")
  vi.stubEnv("VERCEL_TEAM_ID", "team_1")
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: new URL(url as URL), init: init as RequestInit }))

describe("isAutoBypassConfigured", () => {
  it("follows VERCEL_ACCESS_TOKEN", () => {
    expect(isAutoBypassConfigured()).toBe(true)
    vi.stubEnv("VERCEL_ACCESS_TOKEN", "")
    expect(isAutoBypassConfigured()).toBe(false)
  })
})

describe("leaseProtectionBypass", () => {
  it("does nothing without a token, for non-https URLs, and for garbage", async () => {
    vi.stubEnv("VERCEL_ACCESS_TOKEN", "")
    expect(await leaseProtectionBypass("https://proto.vercel.app")).toBeNull()
    vi.stubEnv("VERCEL_ACCESS_TOKEN", "tok_test")
    expect(await leaseProtectionBypass("http://proto.vercel.app")).toBeNull()
    expect(await leaseProtectionBypass("not a url")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resolves via the deployment lookup, mints a caller-chosen 32-char key, and revokes exactly it", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ projectId: "prj_1", ownerId: "team_1" })) // deployment lookup
      .mockResolvedValueOnce(json({ protectionBypass: {} })) // mint
      .mockResolvedValueOnce(json({ protectionBypass: {} })) // revoke

    const lease = await leaseProtectionBypass("https://proto-abc.vercel.app/page?x=1")
    expect(lease).not.toBeNull()
    expect(lease!.projectId).toBe("prj_1")
    expect(lease!.secret).toMatch(/^[a-zA-Z0-9]{32}$/)

    const [lookup, mint] = calls()
    expect(lookup.url.pathname).toBe("/v13/deployments/proto-abc.vercel.app")
    expect(lookup.url.searchParams.get("teamId")).toBe("team_1")
    expect((lookup.init.headers as Record<string, string>).Authorization).toBe("Bearer tok_test")
    expect(mint.url.pathname).toBe("/v1/projects/prj_1/protection-bypass")
    expect(mint.init.method).toBe("PATCH")
    expect(JSON.parse(mint.init.body as string).generate.secret).toBe(lease!.secret)

    await lease!.revoke()
    await lease!.revoke() // idempotent
    const revokes = calls().slice(2)
    expect(revokes).toHaveLength(1)
    expect(JSON.parse(revokes[0].init.body as string)).toEqual({ revoke: { secret: lease!.secret, regenerate: false } })
  })

  it("falls back to the alias lookup for custom domains", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ projectId: "prj_2" }))
      .mockResolvedValueOnce(json({ protectionBypass: {} }))
    const lease = await leaseProtectionBypass("https://proto.example.com/")
    expect(lease!.projectId).toBe("prj_2")
    expect(calls()[1].url.pathname).toBe("/v4/aliases/proto.example.com")
  })

  it("returns null, and mints nothing, for a host that is not one of the team's projects", async () => {
    fetchMock.mockResolvedValue(json({}, 404))
    expect(await leaseProtectionBypass("https://someone-else.example/")).toBeNull()
    expect(calls().every(c => c.init.method === "GET")).toBe(true)
  })

  it("refuses a deployment owned by another team", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ projectId: "prj_x", ownerId: "team_other" }))
      .mockResolvedValueOnce(json({}, 404))
    expect(await leaseProtectionBypass("https://x.vercel.app")).toBeNull()
    expect(calls().some(c => c.init.method === "PATCH")).toBe(false)
  })

  it("throws a VercelBypassError when the API rejects the token or the mint", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403))
    await expect(leaseProtectionBypass("https://x.vercel.app")).rejects.toBeInstanceOf(VercelBypassError)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(json({ projectId: "prj_1" })).mockResolvedValueOnce(json({}, 400))
    await expect(leaseProtectionBypass("https://x.vercel.app")).rejects.toMatchObject({ status: 400 })
  })

  it("puts Vercel's reason and the teamId state in the error, never the token", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: "forbidden", message: "Not authorized", invalidToken: true, extra: "ignored" } }, 403)
    )
    const error = await leaseProtectionBypass("https://x.vercel.app").catch((e: Error) => e)
    expect(error).toBeInstanceOf(VercelBypassError)
    expect((error as Error).message).toContain("returned 403 [forbidden: Not authorized: invalidToken] (teamId sent)")
    expect((error as Error).message).not.toContain("tok_test")
    expect((error as Error).message).not.toContain("ignored")

    vi.stubEnv("VERCEL_TEAM_ID", "")
    fetchMock.mockResolvedValueOnce(new Response("<html>nope</html>", { status: 403 }))
    await expect(leaseProtectionBypass("https://x.vercel.app")).rejects.toThrow("returned 403 (teamId not set)")
  })

  it("retries a failed revoke once, then reports loudly without throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    fetchMock
      .mockResolvedValueOnce(json({ projectId: "prj_1" }))
      .mockResolvedValueOnce(json({ protectionBypass: {} }))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({}, 500))
    const lease = await leaseProtectionBypass("https://x.vercel.app")
    await expect(lease!.revoke()).resolves.toBeUndefined()
    expect(calls().filter(c => c.init.method === "PATCH")).toHaveLength(3) // mint + 2 revoke attempts
    expect(error).toHaveBeenCalledWith(expect.stringContaining("FAILED TO REVOKE"))
    expect(error.mock.calls[0][0]).not.toContain(lease!.secret)
    error.mockRestore()
  })
})
