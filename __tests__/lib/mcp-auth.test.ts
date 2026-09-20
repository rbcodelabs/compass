import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiKey = { findFirst: vi.fn(), update: vi.fn() }
const agent = { findFirst: vi.fn() }
const oAuthToken = { findFirst: vi.fn(), update: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ apiKey, agent, oAuthToken }) }))

import { validateMcpAuth } from "@/lib/mcp-auth"
import { hashOAuthToken } from "@/lib/oauth/tokens"

function request() {
  return new Request("https://compass.test/api/mcp", {
    headers: { authorization: `Bearer cmp_${"a".repeat(32)}` },
  })
}

const OAUTH_TOKEN = `cmp_oat_${"b".repeat(32)}`

function oauthRequest(token = OAUTH_TOKEN) {
  return new Request("https://compass.test/api/mcp", {
    headers: { authorization: `Bearer ${token}` },
  })
}

describe("MCP credential expiry", () => {
  beforeEach(() => vi.clearAllMocks())
  it("derives agent identity from the stored credential and checks its human owner", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: "AGENT", agentId: "agent", expiresAt: null })
    apiKey.update.mockResolvedValue({})
    agent.findFirst.mockResolvedValueOnce({ id: "agent" })
    await expect(validateMcpAuth(request())).resolves.toMatchObject({ valid: true, purpose: "AGENT", userId: "user", agentId: "agent", credentialId: "key" })
    expect(agent.findFirst).toHaveBeenCalledWith({ where: { id: "agent", ownerUserId: "user", status: "ACTIVE" }, select: { id: true } })
    agent.findFirst.mockResolvedValueOnce(null)
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    vi.unstubAllEnvs()
  })
  it("rejects personal credentials carrying an agent identity", async () => {
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: null, agentId: "agent", expiresAt: null })
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("rejects a registered-agent key while rollout is disabled", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: "AGENT", agentId: "agent", expiresAt: null })
    apiKey.update.mockResolvedValue({})
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    vi.unstubAllEnvs()
  })

  it("rejects an assistant-turn credential without workspace and expiry", async () => {
    apiKey.findFirst.mockResolvedValue({ id: "key", userId: "user", purpose: "AGENT_TURN", expiresAt: null })
    apiKey.update.mockResolvedValue({})
    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
  })

  it("accepts an unexpired research credential", async () => {
    apiKey.findFirst.mockResolvedValue({
      id: "key-1",
      userId: "user-1",
      purpose: "RESEARCH",
      scopeWorkspaceId: "workspace-1",
      expiresAt: new Date(Date.now() + 60_000),
    })
    apiKey.update.mockResolvedValue({})

    await expect(validateMcpAuth(request())).resolves.toMatchObject({
      valid: true,
      purpose: "RESEARCH",
    })
  })

  it("fails closed after research credential expiry even if revocation cleanup failed", async () => {
    apiKey.findFirst.mockResolvedValue(null)

    await expect(validateMcpAuth(request())).resolves.toEqual({ valid: false })
    expect(apiKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        revokedAt: null,
        OR: expect.arrayContaining([{ expiresAt: { gt: expect.any(Date) } }]),
      }),
    }))
  })

  it("keeps existing persistent user keys valid when expiry is null", async () => {
    apiKey.findFirst.mockResolvedValue({
      id: "key-2",
      userId: "user-2",
      purpose: null,
      scopeWorkspaceId: null,
      expiresAt: null,
    })
    apiKey.update.mockResolvedValue({})

    await expect(validateMcpAuth(request())).resolves.toMatchObject({
      valid: true,
      purpose: "USER",
    })
  })

  it("keeps the configured service credential independent of database expiry", async () => {
    vi.stubEnv("MCP_API_KEY", "service-secret")
    const serviceRequest = new Request("https://compass.test/api/mcp", {
      headers: { authorization: "Bearer service-secret" },
    })

    await expect(validateMcpAuth(serviceRequest)).resolves.toEqual({
      valid: true,
      userId: null,
      purpose: "SERVICE",
      scopeWorkspaceId: null,
    })
    expect(apiKey.findFirst).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe("OAuth access tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    oAuthToken.update.mockResolvedValue({})
  })

  const row = {
    id: "token-1",
    userId: "user-1",
    scope: "mcp:read mcp:write",
    scopeWorkspaceId: null,
  }

  it("resolves to a USER actor carrying the token's scopes", async () => {
    oAuthToken.findFirst.mockResolvedValue(row)
    await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({
      valid: true,
      userId: "user-1",
      purpose: "USER",
      scopeWorkspaceId: null,
      scopes: ["mcp:read", "mcp:write"],
    })
    // Never RESEARCH, never AGENT: purpose is pinned, not read from the row.
    expect(apiKey.findFirst).not.toHaveBeenCalled()
  })

  it("filters on the canonical audience, the ACCESS type, revocation and expiry", async () => {
    oAuthToken.findFirst.mockResolvedValue(row)
    await validateMcpAuth(oauthRequest())
    expect(oAuthToken.findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: hashOAuthToken(OAUTH_TOKEN),
        type: "ACCESS",
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
        // The spec's hardest MUST: a token minted for any other audience must
        // never match, so this predicate cannot be dropped.
        resource: "http://localhost:3000/api/mcp",
      },
      select: { id: true, userId: true, scope: true, scopeWorkspaceId: true, authorizationMode: true, agentId: true },
    })
  })

  it("rejects when no row matches, without falling through to the API-key lookup", async () => {
    oAuthToken.findFirst.mockResolvedValue(null)
    await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({ valid: false })
    expect(apiKey.findFirst).not.toHaveBeenCalled()
  })

  it("records lastUsedAt without blocking the request", async () => {
    oAuthToken.findFirst.mockResolvedValue(row)
    await validateMcpAuth(oauthRequest())
    expect(oAuthToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: expect.any(Date) },
    })
  })

  it("survives a failed lastUsedAt write", async () => {
    oAuthToken.findFirst.mockResolvedValue(row)
    oAuthToken.update.mockRejectedValue(new Error("write conflict"))
    await expect(validateMcpAuth(oauthRequest())).resolves.toMatchObject({ valid: true })
  })

  it("refuses every OAuth token when the deployment cannot name its own audience", async () => {
    // VERCEL_ENV=production with no NEXT_PUBLIC_APP_URL makes
    // trustedCompassBaseUrl() throw — there is no canonical resource to compare
    // against, so the audience cannot be verified and the token must not act.
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    try {
      await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({ valid: false })
      expect(oAuthToken.findFirst).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not treat a refresh token as a bearer credential", async () => {
    await expect(validateMcpAuth(oauthRequest(`cmp_ort_${"c".repeat(32)}`))).resolves.toEqual({
      valid: false,
    })
    expect(oAuthToken.findFirst).not.toHaveBeenCalled()
  })
})

/**
 * The escalation matrix for ADR 0015. Every case below asserts the *same*
 * property from a different direction: an agent-bound token either acts as its
 * agent or does not act at all. There is no third outcome, and in particular
 * there is no downgrade to `purpose: "USER"` — that would make flipping
 * COMPASS_AGENTS_ENABLED off a privilege escalation, and would let a suspended
 * agent keep working through OAuth while failing through its own key.
 */
describe("OAuth access tokens bound to an agent", () => {
  const agentRow = {
    id: "token-1",
    userId: "user-1",
    scope: "mcp:read mcp:write",
    scopeWorkspaceId: null,
    authorizationMode: "AGENT",
    agentId: "agent-1",
  }

  beforeEach(() => {
    vi.clearAllMocks()
    oAuthToken.update.mockResolvedValue({})
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "1")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("resolves to an AGENT actor carrying agentId, credentialId and credentialType", async () => {
    oAuthToken.findFirst.mockResolvedValue(agentRow)
    agent.findFirst.mockResolvedValue({ id: "agent-1" })
    await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({
      valid: true,
      userId: "user-1",
      purpose: "AGENT",
      agentId: "agent-1",
      // The whole point: withAgentActivity throws "Incomplete agent identity."
      // without this, so every read would work and every write would fail.
      credentialId: "token-1",
      credentialType: "OAUTH",
      scopeWorkspaceId: null,
      scopes: ["mcp:read", "mcp:write"],
    })
  })

  it("re-checks agent ownership and liveness on every request, never trusting issuance", async () => {
    oAuthToken.findFirst.mockResolvedValue(agentRow)
    agent.findFirst.mockResolvedValue({ id: "agent-1" })
    await validateMcpAuth(oauthRequest())
    // Identical predicate to the ApiKey AGENT branch: owned by the token's own
    // user, and ACTIVE. An agent belonging to someone else can never match.
    expect(agent.findFirst).toHaveBeenCalledWith({
      where: { id: "agent-1", ownerUserId: "user-1", status: "ACTIVE" },
      select: { id: true },
    })
  })

  it("refuses, and does not downgrade, when the agent is suspended or deleted", async () => {
    oAuthToken.findFirst.mockResolvedValue(agentRow)
    agent.findFirst.mockResolvedValue(null)
    await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({ valid: false })
  })

  it("refuses, and does not downgrade, while the agent rollout is disabled", async () => {
    vi.stubEnv("COMPASS_AGENTS_ENABLED", "0")
    oAuthToken.findFirst.mockResolvedValue(agentRow)
    await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({ valid: false })
    // Refused before the agent lookup — the flag is checked first, exactly as
    // on the key path.
    expect(agent.findFirst).not.toHaveBeenCalled()
  })

  it("refuses an AGENT-mode row whose agentId is missing", async () => {
    oAuthToken.findFirst.mockResolvedValue({ ...agentRow, agentId: null })
    await expect(validateMcpAuth(oauthRequest())).resolves.toEqual({ valid: false })
    expect(agent.findFirst).not.toHaveBeenCalled()
  })

  const NON_AGENT_MODES: Array<[string | null, string]> = [
    ["USER", "the admin override"],
    [null, "a row written before migration 056"],
    ["RESEARCH", "a value the switch does not recognise"],
    ["AGENT_TURN", "a purpose no OAuth token may ever take"],
    ["agent", "the right word in the wrong case"],
  ]
  it.each(NON_AGENT_MODES)("treats authorizationMode %s as USER mode (%s)", async (mode) => {
    // A closed two-way switch, never a pass-through of a stored purpose string.
    // RESEARCH and AGENT_TURN in particular must not become reachable by
    // writing a string into a column.
    oAuthToken.findFirst.mockResolvedValue({ ...agentRow, authorizationMode: mode })
    await expect(validateMcpAuth(oauthRequest())).resolves.toMatchObject({
      valid: true,
      purpose: "USER",
    })
    expect(agent.findFirst).not.toHaveBeenCalled()
  })

  it("pins scopeWorkspaceId to null so grants are the only workspace narrowing", async () => {
    // Even if a stray value is on the row, the agent path must not honour it:
    // scopeWorkspaceId is superseded and is not a complete boundary as built.
    oAuthToken.findFirst.mockResolvedValue({ ...agentRow, scopeWorkspaceId: "workspace-9" })
    agent.findFirst.mockResolvedValue({ id: "agent-1" })
    await expect(validateMcpAuth(oauthRequest())).resolves.toMatchObject({
      purpose: "AGENT",
      scopeWorkspaceId: null,
    })
  })

  it("still enforces the scopes the token was granted", async () => {
    oAuthToken.findFirst.mockResolvedValue({ ...agentRow, scope: "mcp:read" })
    agent.findFirst.mockResolvedValue({ id: "agent-1" })
    await expect(validateMcpAuth(oauthRequest())).resolves.toMatchObject({ scopes: ["mcp:read"] })
  })
})
