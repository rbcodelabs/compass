import { createVerify, generateKeyPairSync } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_GITHUB_CODE_READ_PERMISSIONS, AGENT_GITHUB_PERMISSIONS, AGENT_GITHUB_READ_PERMISSIONS, checkAppAccessOn, githubAppConfigured, mintAgentGithubEnv, mintRepoInstallationToken, parseAgentRepos, resetGithubAppInstallationCache, signAppJwt } from "@/lib/github-app-token"
import { ConnectError, connectMocks, resetConnectMocks } from "../helpers/mock-vercel-connect"

vi.mock("@vercel/connect", async () => (await import("../helpers/mock-vercel-connect")).connectModule())

beforeEach(() => {
  resetConnectMocks()
  connectMocks.getTokenResponse.mockResolvedValue({ token: "ghs_x", expiresAt: 1_900_000_000_000 })
  vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "github/compass")
})
afterEach(() => vi.unstubAllEnvs())

describe("mintRepoInstallationToken", () => {
  it("asks Connect for an app token refined to the repos and agent permissions", async () => {
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a", "b"] })).resolves.toEqual({ token: "ghs_x", expiresAt: 1_900_000_000_000 })
    expect(connectMocks.getTokenResponse).toHaveBeenCalledWith("github/compass", {
      subject: { type: "app" },
      authorizationDetails: [{ type: "github_app_installation", org: "acme", repositories: ["a", "b"], permissions: [...AGENT_GITHUB_PERMISSIONS] }],
    })
    expect(AGENT_GITHUB_PERMISSIONS).toEqual(["contents:write", "pull_requests:write", "metadata:read"])
  })
  it("fails closed without leaking upstream detail", async () => {
    connectMocks.getTokenResponse.mockRejectedValue(new ConnectError("secret detail", { code: "forbidden", status: 403 }))
    await expect(mintRepoInstallationToken({ owner: "a", names: ["b"] })).rejects.toThrow(/^Vercel Connect GitHub token request failed \(403\)$/)
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "")
    await expect(mintRepoInstallationToken({ owner: "a", names: ["b"] })).rejects.toThrow(/must be configured/)
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "github/compass")
    await expect(mintRepoInstallationToken({ owner: "a/../x", names: ["b"] })).rejects.toThrow(/Invalid repository/)
    await expect(mintRepoInstallationToken({ owner: "a", names: [] })).rejects.toThrow(/Invalid repository/)
  })
})

describe("checkAppAccessOn", () => {
  it("is ok when Connect mints a token at the requested level", async () => {
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "write")).resolves.toBe("ok")
  })
  it("is missing_permission when the full request fails but a metadata-only one mints", async () => {
    connectMocks.getTokenResponse.mockRejectedValueOnce(new ConnectError("nope", { status: 422 }))
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "write")).resolves.toBe("missing_permission")
    expect(connectMocks.getTokenResponse.mock.calls[1][1].authorizationDetails[0].permissions).toEqual(["metadata:read"])
  })
  it.each([401, 429, 500])("keeps Connect HTTP %s failures distinct from missing installation", async (status) => {
    connectMocks.getTokenResponse.mockRejectedValue(new ConnectError("upstream detail", { status }))
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "read")).resolves.toBe("probe_failed")
    expect(connectMocks.getTokenResponse).toHaveBeenCalledTimes(1)
  })

  it("reports an inconclusive Connect metadata probe as a failed check", async () => {
    connectMocks.getTokenResponse.mockRejectedValue(new ConnectError("nope", { status: 422 }))
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "read")).resolves.toBe("probe_failed")
    expect(connectMocks.getTokenResponse).toHaveBeenCalledTimes(2)
  })
})

describe("read-only access", () => {
  it("requests only read permissions and tags the env", async () => {
    expect(AGENT_GITHUB_READ_PERMISSIONS).toEqual(["contents:read", "pull_requests:read", "metadata:read"])
    await expect(mintAgentGithubEnv(["acme/a"], "read")).resolves.toMatchObject({ AGENT_GITHUB_ACCESS: "read" })
    expect(connectMocks.getTokenResponse.mock.calls[0][1].authorizationDetails[0].permissions).toEqual([...AGENT_GITHUB_READ_PERMISSIONS])
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
  it("returns nothing for an empty list or an unset connector, without calling Connect", async () => {
    await expect(mintAgentGithubEnv([])).resolves.toEqual({})
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "")
    await expect(mintAgentGithubEnv(["a/b"])).resolves.toEqual({})
    expect(connectMocks.getTokenResponse).not.toHaveBeenCalled()
  })
  it("returns nothing for an invalid list", async () => {
    await expect(mintAgentGithubEnv(["a/b", "c/d"])).resolves.toEqual({})
    expect(connectMocks.getTokenResponse).not.toHaveBeenCalled()
  })
  it("mints one token covering every repo and exposes it as GH_TOKEN/GITHUB_TOKEN", async () => {
    await expect(mintAgentGithubEnv(["acme/a", "acme/b"])).resolves.toEqual({ GH_TOKEN: "ghs_x", GITHUB_TOKEN: "ghs_x", AGENT_GITHUB_REPOS: "acme/a,acme/b", AGENT_GITHUB_ACCESS: "write" })
    expect(connectMocks.getTokenResponse.mock.calls[0][1].authorizationDetails[0].repositories).toEqual(["a", "b"])
  })
  it("is fail-soft when Connect errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    connectMocks.getTokenResponse.mockRejectedValue(new Error("boom"))
    await expect(mintAgentGithubEnv(["acme/a"])).resolves.toEqual({})
    spy.mockRestore()
  })
})

describe("code-only read access", () => {
  it("requests contents and metadata only, with no pull request permission", async () => {
    expect(AGENT_GITHUB_CODE_READ_PERMISSIONS).toEqual(["contents:read", "metadata:read"])
    await expect(mintAgentGithubEnv(["acme/a"], "code-read")).resolves.toMatchObject({ AGENT_GITHUB_ACCESS: "code-read" })
    expect(connectMocks.getTokenResponse.mock.calls[0][1].authorizationDetails[0].permissions).toEqual([...AGENT_GITHUB_CODE_READ_PERMISSIONS])
  })
})

describe("direct GitHub App path (no Connect)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string

  beforeEach(() => {
    resetGithubAppInstallationCache()
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "")
    vi.stubEnv("COMPASS_GITHUB_APP_ID", "123")
    vi.stubEnv("COMPASS_GITHUB_APP_PRIVATE_KEY", pem)
  })
  afterEach(() => vi.unstubAllGlobals())

  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

  it("is configured by app id plus key, and by neither alone", () => {
    expect(githubAppConfigured()).toBe(true)
    vi.stubEnv("COMPASS_GITHUB_APP_PRIVATE_KEY", "")
    expect(githubAppConfigured()).toBe(false)
    vi.stubEnv("COMPASS_GITHUB_APP_PRIVATE_KEY", pem)
    vi.stubEnv("COMPASS_GITHUB_APP_ID", "")
    expect(githubAppConfigured()).toBe(false)
  })

  it("signs a verifiable RS256 JWT with backdated iat and a sub-10-minute exp", () => {
    const jwt = signAppJwt("123", pem, 1_000_000)
    const [h, p, s] = jwt.split(".")
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url")).toBe(true)
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123" })
  })

  it("looks up the org installation, then mints a token refined to repos and permissions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 42 }))
      .mockResolvedValueOnce(json(201, { token: "ghs_direct", expires_at: "2030-01-01T00:00:00Z" }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a", "b"] })).resolves.toEqual({ token: "ghs_direct", expiresAt: Date.parse("2030-01-01T00:00:00Z") })
    expect(connectMocks.getTokenResponse).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/orgs/acme/installation")
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe("https://api.github.com/app/installations/42/access_tokens")
    expect(init.method).toBe("POST")
    expect(JSON.parse(init.body)).toEqual({ repositories: ["a", "b"], permissions: { contents: "write", pull_requests: "write", metadata: "read" } })
    expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it("falls back to the user installation and caches the id per owner", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(404, {}))
      .mockResolvedValueOnce(json(200, { id: 7 }))
      .mockResolvedValue(json(201, { token: "ghs_u", expires_at: "2030-01-01T00:00:00Z" }))
    vi.stubGlobal("fetch", fetchMock)
    await mintRepoInstallationToken({ owner: "someone", names: ["r"] })
    await mintRepoInstallationToken({ owner: "Someone", names: ["r"] })
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      "https://api.github.com/orgs/someone/installation",
      "https://api.github.com/users/someone/installation",
      "https://api.github.com/app/installations/7/access_tokens",
      "https://api.github.com/app/installations/7/access_tokens",
    ])
  })

  it("reports not installed, and never echoes upstream bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(404, { message: "secret detail" })))
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a"] })).rejects.toThrow(/^GitHub App is not installed on acme$/)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(200, { id: 1 })).mockResolvedValueOnce(json(422, { message: "secret detail" })))
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a"] })).rejects.toThrow(/^GitHub App token request failed \(422\)$/)
  })

  it("distinguishes a rejected signing key from a missing installation", async () => {
    vi.stubEnv("COMPASS_GITHUB_APP_PRIVATE_KEY", "not-a-key")
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "read")).resolves.toBe("probe_failed")
  })

  it("reports not_installed when both installation lookups return 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(404, {}))
    vi.stubGlobal("fetch", fetchMock)
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "read")).resolves.toBe("not_installed")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("reports missing_permission when the direct metadata-only token mints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 42 }))
      .mockResolvedValueOnce(json(422, {}))
      .mockResolvedValueOnce(json(201, { token: "ghs_metadata", expires_at: "2030-01-01T00:00:00Z" }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(checkAppAccessOn({ owner: "acme", name: "a" }, "read")).resolves.toBe("missing_permission")
  })

  it("rejects an unusable key without leaking it", async () => {
    vi.stubEnv("COMPASS_GITHUB_APP_PRIVATE_KEY", "not-a-key")
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a"] })).rejects.toThrow(/^COMPASS_GITHUB_APP_PRIVATE_KEY is not a valid private key$/)
  })

  it("redacts upstream JSON parser failures before they reach callers or logs", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(json(200, { id: 42 }))
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => { throw new SyntaxError("upstream detail") } }))
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a"] })).rejects.toThrow(/^GitHub App token request failed$/)
  })

  it("feeds mintAgentGithubEnv with the signed token and the access level", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { id: 42 }))
      .mockResolvedValueOnce(json(201, { token: "ghs_env", expires_at: "2030-01-01T00:00:00Z" }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(mintAgentGithubEnv(["acme/a"], "read")).resolves.toMatchObject({ GH_TOKEN: "ghs_env", AGENT_GITHUB_ACCESS: "read" })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).permissions).toEqual({ contents: "read", pull_requests: "read", metadata: "read" })
  })

  it("prefers the Connect connector when both paths are configured", async () => {
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "github/compass")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(mintRepoInstallationToken({ owner: "acme", names: ["a"] })).resolves.toMatchObject({ token: "ghs_x" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("is unconfigured when no connector and no app credentials are set (default stays off)", async () => {
    vi.stubEnv("COMPASS_GITHUB_APP_ID", "")
    vi.stubEnv("COMPASS_GITHUB_APP_PRIVATE_KEY", "")
    expect(githubAppConfigured()).toBe(false)
    await expect(mintAgentGithubEnv(["acme/a"])).resolves.toEqual({})
    expect(connectMocks.getTokenResponse).not.toHaveBeenCalled()
  })
})
