import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AGENT_GITHUB_PERMISSIONS, isAppInstalledOn, mintAgentGithubEnv, mintRepoInstallationToken, parseAgentRepos } from "@/lib/github-app-token"
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
    await expect(mintRepoInstallationToken({ owner: "a", names: ["b"] })).rejects.toThrow(/^Vercel Connect GitHub token request failed \(forbidden\)$/)
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "")
    await expect(mintRepoInstallationToken({ owner: "a", names: ["b"] })).rejects.toThrow(/must be configured/)
    vi.stubEnv("COMPASS_GITHUB_CONNECTOR", "github/compass")
    await expect(mintRepoInstallationToken({ owner: "a/../x", names: ["b"] })).rejects.toThrow(/Invalid repository/)
    await expect(mintRepoInstallationToken({ owner: "a", names: [] })).rejects.toThrow(/Invalid repository/)
  })
})

describe("isAppInstalledOn", () => {
  it("is true when Connect mints a token for the repo and false when it refuses", async () => {
    await expect(isAppInstalledOn({ owner: "acme", name: "a" })).resolves.toBe(true)
    connectMocks.getTokenResponse.mockRejectedValue(new ConnectError("nope", { status: 422 }))
    await expect(isAppInstalledOn({ owner: "acme", name: "a" })).resolves.toBe(false)
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
    await expect(mintAgentGithubEnv(["acme/a", "acme/b"])).resolves.toEqual({ GH_TOKEN: "ghs_x", GITHUB_TOKEN: "ghs_x", AGENT_GITHUB_REPOS: "acme/a,acme/b" })
    expect(connectMocks.getTokenResponse.mock.calls[0][1].authorizationDetails[0].repositories).toEqual(["a", "b"])
  })
  it("is fail-soft when Connect errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    connectMocks.getTokenResponse.mockRejectedValue(new Error("boom"))
    await expect(mintAgentGithubEnv(["acme/a"])).resolves.toEqual({})
    spy.mockRestore()
  })
})
