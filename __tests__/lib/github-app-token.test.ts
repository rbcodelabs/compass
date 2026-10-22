import { generateKeyPairSync, createVerify } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AGENT_GITHUB_PERMISSIONS, createAppJwt, mintAgentGithubEnv, mintRepoInstallationToken, parseAgentRepos } from "@/lib/github-app-token"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("GitHub App installation tokens", () => {
  it("signs a verifiable RS256 JWT, accepting \\n-escaped PEMs", () => {
    const jwt = createAppJwt("123", pem.replace(/\n/g, "\\n"), 1_000_000)
    const [h, p, s] = jwt.split(".")
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123" })
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true)
  })
  it("mints a token scoped to one repo and the agent permission set", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ id: 42 })).mockResolvedValueOnce(json({ token: "ghs_x", expires_at: "2026-10-20T11:00:00Z" }, 201))
    expect(await mintRepoInstallationToken({ owner: "bankrate-prototypes", name: "demo" }, { appId: "1", privateKey: pem, fetcher })).toEqual({ token: "ghs_x", expiresAt: "2026-10-20T11:00:00Z" })
    expect(fetcher.mock.calls[0][0]).toBe("https://api.github.com/repos/bankrate-prototypes/demo/installation")
    const [url, init] = fetcher.mock.calls[1]
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens")
    expect(JSON.parse(init.body)).toEqual({ repositories: ["demo"], permissions: AGENT_GITHUB_PERMISSIONS })
  })
  it("fails closed without leaking response bodies", async () => {
    await expect(mintRepoInstallationToken({ owner: "a", name: "b" }, { appId: "1", privateKey: pem, fetcher: vi.fn().mockResolvedValue(json({ message: "secret detail" }, 404)) })).rejects.toThrow(/^GitHub App request failed \(404\)$/)
    await expect(mintRepoInstallationToken({ owner: "a", name: "b" }, { appId: "", privateKey: "" })).rejects.toThrow(/must be configured/)
    await expect(mintRepoInstallationToken({ owner: "a/../x", name: "b" }, { appId: "1", privateKey: pem })).rejects.toThrow(/Invalid repository/)
  })
})

describe("parseAgentRepos", () => {
  it("normalizes urls, dedupes, and rejects mixed owners or bad entries", () => {
    expect(parseAgentRepos(["https://github.com/Acme/app.git", "acme/app", " acme/api "])).toEqual({ ok: true, repos: ["Acme/app", "acme/api"] })
    expect(parseAgentRepos(["a/b", "c/d"])).toMatchObject({ ok: false })
    expect(parseAgentRepos(["nope"])).toMatchObject({ ok: false })
    expect(parseAgentRepos(Array.from({ length: 11 }, (_, n) => `a/r${n}`))).toMatchObject({ ok: false })
  })
})

describe("mintAgentGithubEnv", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("returns nothing for an empty list or missing app credentials", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1")
    vi.stubEnv("GITHUB_PRIVATE_KEY", "x")
    await expect(mintAgentGithubEnv([])).resolves.toEqual({})
    vi.stubEnv("GITHUB_APP_ID", "")
    await expect(mintAgentGithubEnv(["a/b"])).resolves.toEqual({})
  })

  it("returns nothing for an invalid list without calling GitHub", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1")
    vi.stubEnv("GITHUB_PRIVATE_KEY", "x")
    await expect(mintAgentGithubEnv(["a/b", "c/d"])).resolves.toEqual({})
  })
})

describe("mintRepoInstallationToken with several repos", () => {
  it("requests one token covering every listed repo", async () => {
    const calls: { url: string; body?: string }[] = []
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string | undefined })
      return String(url).endsWith("/installation") ? json({ id: 7 }) : json({ token: "t", expires_at: "2030-01-01T00:00:00Z" })
    })
    await mintRepoInstallationToken({ owner: "acme", name: "a", names: ["a", "b"] }, { appId: "1", privateKey: pem, fetcher })
    expect(JSON.parse(calls[1].body!).repositories).toEqual(["a", "b"])
  })
})
