/**
 * `POST /api/oauth/token`, end to end against the in-memory store.
 *
 * The lib-level suites cover the primitives; this one covers the wiring that
 * only exists in the route — that PKCE is actually verified before a token is
 * minted, that a code presented by the wrong client is refused, that a refresh
 * token is issued whether or not `offline_access` was requested, and that a
 * replayed code takes its tokens with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "./helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import { POST } from "@/app/api/oauth/token/route"
import { issueAuthorizationCode } from "@/lib/oauth/codes"
import { computeS256Challenge } from "@/lib/oauth/pkce"
import { hashOAuthToken, mintClientSecret } from "@/lib/oauth/tokens"

const ORIGIN = "https://compass.example.com"
const RESOURCE = `${ORIGIN}/api/mcp`
const CLIENT_ID = "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const VERIFIER = "a".repeat(64)
const REDIRECT_URI = "http://127.0.0.1:54321/callback"

function post(fields: Record<string, string>) {
  return POST(
    new Request(`${ORIGIN}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  )
}

async function registerClient(overrides: Record<string, unknown> = {}) {
  await store.oAuthClient.create({
    data: {
      clientId: CLIENT_ID,
      clientName: "Agent Threads",
      redirectUris: ["http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      scope: "mcp:read mcp:write offline_access",
      tokenEndpointAuthMethod: "none",
      ...overrides,
    },
  })
}

async function issueCode(overrides: Record<string, string> = {}, rememberConsent = true) {
  const scope = overrides.scope ?? "mcp:read mcp:write"
  const authorizationMode = overrides.authorizationMode ?? "USER"
  const agentId = overrides.agentId ?? null
  if (rememberConsent) {
    await store.oAuthConsent.upsert({
      where: { userId_clientId: { userId: "user-1", clientId: CLIENT_ID } },
      create: { userId: "user-1", clientId: CLIENT_ID, scope, authorizationMode, agentId },
      update: { scope, authorizationMode, agentId, grantedAt: new Date() },
    })
  }
  const { code } = await issueAuthorizationCode({
    clientId: CLIENT_ID,
    userId: "user-1",
    redirectUri: REDIRECT_URI,
    codeChallenge: computeS256Challenge(VERIFIER),
    codeChallengeMethod: "S256",
    scope: "mcp:read mcp:write",
    resource: RESOURCE,
    authorizationMode: "USER",
    ...overrides,
  })
  return code
}

const exchange = (code: string, extra: Record<string, string> = {}) =>
  post({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
    ...extra,
  })

beforeEach(async () => {
  store.reset()
  // Call history too, not just rows — one test asserts a query was *not* made.
  vi.clearAllMocks()
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
  await registerClient()
})
afterEach(() => vi.unstubAllEnvs())

describe("authorization_code grant", () => {
  it("exchanges a valid code for an access and refresh token", async () => {
    const response = await exchange(await issueCode())
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body.access_token).toMatch(/^cmp_oat_[0-9a-f]{32}$/)
    expect(body.refresh_token).toMatch(/^cmp_ort_[0-9a-f]{32}$/)
    expect(body.token_type).toBe("Bearer")
    expect(body.scope).toBe("mcp:read mcp:write")
    // RFC 6749 §5.1 — a token response must never be cached.
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("issues a refresh token even though offline_access was never requested", async () => {
    // The Geode broker requests the refresh_token *grant* at DCR but never adds
    // offline_access to its scope string, and its proxy depends on refresh to
    // recover from an upstream 401. Gating on the scope would break every install.
    const body = await (await exchange(await issueCode({ scope: "mcp:read" }))).json()
    expect(body.refresh_token).toMatch(/^cmp_ort_/)
    expect(body.scope).toBe("mcp:read")
  })

  it("binds the token to the audience the authorization request carried", async () => {
    await exchange(await issueCode())
    for (const row of store.oAuthToken.rows) expect(row.resource).toBe(RESOURCE)
  })

  it("rejects a wrong code_verifier — and burns the code doing it", async () => {
    const code = await issueCode()
    const wrong = await exchange(code, { code_verifier: "b".repeat(64) })

    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows).toHaveLength(0)

    // A single-use code that survives a failed exchange is an oracle: an
    // attacker with the code but not the verifier could keep guessing.
    const retry = await exchange(code)
    expect(retry.status).toBe(400)
    expect(store.oAuthToken.rows).toHaveLength(0)
  })

  it("rejects a missing code_verifier", async () => {
    const response = await post({
      grant_type: "authorization_code",
      code: await issueCode(),
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    })
    expect((await response.json()).error).toBe("invalid_grant")
  })

  it("revokes everything a replayed code produced", async () => {
    const code = await issueCode()
    const first = await exchange(code)
    expect(first.status).toBe(200)

    const replay = await exchange(code)
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe("invalid_grant")

    // OAuth 2.1 §4.1.3: a second exchange means the code leaked, so the tokens
    // it minted are no longer trustworthy.
    expect(store.oAuthToken.rows).toHaveLength(2)
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("issues exactly one token pair for two concurrent exchanges of one code", async () => {
    const code = await issueCode()
    const [a, b] = await Promise.all([exchange(code), exchange(code)])

    expect([a.status, b.status].filter((status) => status === 200)).toHaveLength(1)
    // Two pairs would be a double-spend no downstream check could detect,
    // because both tokens would be individually valid.
    expect(store.oAuthToken.rows.filter((row) => row.type === "ACCESS")).toHaveLength(1)
  })

  it("rejects a code presented by a different client, and revokes it", async () => {
    await registerClient({ clientId: "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
    const code = await issueCode()

    const response = await post({
      grant_type: "authorization_code",
      code,
      client_id: "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows).toHaveLength(0)
  })

  it("rejects a mismatched redirect_uri", async () => {
    const response = await exchange(await issueCode(), {
      redirect_uri: "http://127.0.0.1:99999/callback",
    })
    expect((await response.json()).error).toBe("invalid_grant")
  })

  it("rejects an expired code", async () => {
    const code = await issueCode()
    const row = store.oAuthAuthorizationCode.rows[0]
    row.expiresAt = new Date(Date.now() - 1000)

    const response = await exchange(code)
    expect((await response.json()).error).toBe("invalid_grant")
  })

  it("rejects a resource that disagrees with the authorization request", async () => {
    const response = await exchange(await issueCode(), {
      resource: "https://evil.example.com/api/mcp",
    })
    expect((await response.json()).error).toBe("invalid_target")
  })

  it("accepts the canonical resource when the client does send it", async () => {
    const response = await exchange(await issueCode(), { resource: RESOURCE })
    expect(response.status).toBe(200)
  })

  it("stamps lastUsedAt on the client", async () => {
    await exchange(await issueCode())
    await Promise.resolve()
    expect(store.oAuthClient.rows[0].lastUsedAt).toBeInstanceOf(Date)
  })

  it("rejects an already-issued code after its connection is revoked", async () => {
    const code = await issueCode()
    await store.oAuthConsent.deleteMany({ where: { userId: "user-1", clientId: CLIENT_ID } })

    const response = await exchange(code)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows).toHaveLength(0)
  })

  it("does not issue tokens when revocation wins after the consent snapshot read", async () => {
    const code = await issueCode()
    const [consent] = store.oAuthConsent.rows
    store.oAuthConsent.updateMany.mockImplementationOnce(async ({ where, data }) => {
      expect(where).toEqual({
        id: consent.id,
        userId: "user-1",
        clientId: CLIENT_ID,
        scope: consent.scope,
        authorizationMode: consent.authorizationMode,
        agentId: consent.agentId,
        grantedAt: consent.grantedAt,
      })
      expect(data).toEqual({ grantedAt: consent.grantedAt })
      await store.oAuthConsent.deleteMany({ where: { userId: "user-1", clientId: CLIENT_ID } })
      return { count: 0 }
    })

    const response = await exchange(code)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows).toHaveLength(0)
  })

  it("rejects a pre-migration code after forced re-consent removed every consent", async () => {
    const code = await issueCode({}, false)

    const response = await exchange(code)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows).toHaveLength(0)
  })

  it.each([null, "RESEARCH", "agent"])(
    "refuses a code carrying invalid authorizationMode %s",
    async (authorizationMode) => {
      const code = await issueCode()
      store.oAuthAuthorizationCode.rows[0].authorizationMode = authorizationMode

      const response = await exchange(code)

      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe("invalid_grant")
      expect(store.oAuthToken.rows).toHaveLength(0)
    },
  )
})

describe("client authentication", () => {
  it("accepts a public client presenting only client_id", async () => {
    expect((await exchange(await issueCode())).status).toBe(200)
  })

  it("rejects a public client that nonetheless sends a secret", async () => {
    const response = await exchange(await issueCode(), { client_secret: "anything" })
    expect(response.status).toBe(401)
    expect((await response.json()).error).toBe("invalid_client")
  })

  it("requires the right secret from a confidential client", async () => {
    const secret = mintClientSecret()
    store.reset()
    await registerClient({
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecretHash: secret.clientSecretHash,
    })

    const withoutSecret = await exchange(await issueCode())
    expect(withoutSecret.status).toBe(401)

    const wrongSecret = await exchange(await issueCode(), { client_secret: "cmp_ocs_wrong" })
    expect(wrongSecret.status).toBe(401)

    const right = await exchange(await issueCode(), { client_secret: secret.clientSecret })
    expect(right.status).toBe(200)
  })

  it("gives the same answer for an unknown client and a wrong secret", async () => {
    const unknown = await post({
      grant_type: "authorization_code",
      code: await issueCode(),
      client_id: "cmp_oc_" + "9".repeat(32),
      code_verifier: VERIFIER,
    })
    expect(unknown.status).toBe(401)
    // Distinguishing the two would make this endpoint a client-id oracle.
    expect((await unknown.json()).error_description).toBe("Client authentication failed.")
  })

  it("refuses a grant the client did not register for", async () => {
    store.reset()
    await registerClient({ grantTypes: ["authorization_code"] })
    const response = await post({
      grant_type: "refresh_token",
      refresh_token: "cmp_ort_" + "0".repeat(32),
      client_id: CLIENT_ID,
    })
    expect((await response.json()).error).toBe("unauthorized_client")
  })
})

describe("refresh_token grant", () => {
  async function seedOverrideEligible() {
    await store.organizationMember.create({
      data: { organizationId: "org-1", userId: "user-1", role: "OWNER" },
    })
  }

  async function firstPair() {
    await seedOverrideEligible()
    return (await exchange(await issueCode())).json()
  }

  const refresh = (token: string, extra: Record<string, string> = {}) =>
    post({ grant_type: "refresh_token", refresh_token: token, client_id: CLIENT_ID, ...extra })

  it("rotates: the new refresh token differs and the old one stops working", async () => {
    const initial = await firstPair()
    const rotated = await (await refresh(initial.refresh_token)).json()

    expect(rotated.refresh_token).not.toBe(initial.refresh_token)
    expect(rotated.access_token).not.toBe(initial.access_token)

    const replay = await refresh(initial.refresh_token)
    expect(replay.status).toBe(400)
    expect((await replay.json()).error).toBe("invalid_grant")
  })

  it("revokes the whole family when a rotated token is replayed", async () => {
    const initial = await firstPair()
    const rotated = await (await refresh(initial.refresh_token)).json()
    await refresh(initial.refresh_token)

    // Including the generation issued after the rotation — which is exactly the
    // one an attacker replaying a stolen token would be holding.
    const live = store.oAuthToken.rows.filter((row) => row.revokedAt === null)
    expect(live).toHaveLength(0)

    const afterRevocation = await refresh(rotated.refresh_token)
    expect(afterRevocation.status).toBe(400)
  })

  it("keeps the family id across rotations so reuse detection still reaches back", async () => {
    const initial = await firstPair()
    await refresh(initial.refresh_token)
    const families = new Set(store.oAuthToken.rows.map((row) => row.familyId))
    expect(families.size).toBe(1)
  })

  it("records the rotation lineage on the new tokens", async () => {
    const initial = await firstPair()
    await refresh(initial.refresh_token)
    const parent = store.oAuthToken.rows.find(
      (row) => row.tokenHash === hashOAuthToken(initial.refresh_token),
    )
    const rotated = store.oAuthToken.rows.filter((row) => row.parentTokenId !== null)
    expect(rotated).toHaveLength(2)
    expect(rotated.every((row) => row.parentTokenId === parent?.id)).toBe(true)
  })

  it("narrows scope on request but refuses to widen it", async () => {
    const initial = await firstPair()

    const narrowed = await (await refresh(initial.refresh_token, { scope: "mcp:read" })).json()
    expect(narrowed.scope).toBe("mcp:read")

    const widened = await refresh(narrowed.refresh_token, { scope: "mcp:read mcp:write" })
    expect(widened.status).toBe(400)
    expect((await widened.json()).error).toBe("invalid_scope")
  })

  it("rejects a refresh token belonging to another client", async () => {
    const initial = await firstPair()
    await registerClient({ clientId: "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })

    const response = await post({
      grant_type: "refresh_token",
      refresh_token: initial.refresh_token,
      client_id: "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })
    expect(response.status).toBe(400)
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("rejects a value that is not shaped like one of our refresh tokens", async () => {
    const response = await refresh("not-a-compass-token")
    expect((await response.json()).error).toBe("invalid_grant")
    // Structural rejection, before any database round trip.
    expect(store.oAuthToken.findUnique).not.toHaveBeenCalled()
  })

  it("revokes the family instead of rotating after its connection is revoked", async () => {
    const initial = await firstPair()
    await store.oAuthConsent.deleteMany({ where: { userId: "user-1", clientId: CLIENT_ID } })

    const response = await refresh(initial.refresh_token)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("does not rotate when revocation wins after the consent snapshot read", async () => {
    const initial = await firstPair()
    store.oAuthConsent.updateMany.mockImplementationOnce(async () => {
      await store.oAuthConsent.deleteMany({ where: { userId: "user-1", clientId: CLIENT_ID } })
      return { count: 0 }
    })

    const response = await refresh(initial.refresh_token)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows).toHaveLength(2)
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("revokes the family when the user loses organization-admin eligibility", async () => {
    const initial = await firstPair()
    await store.organizationMember.updateMany({
      where: { organizationId: "org-1", userId: "user-1" },
      data: { role: "MEMBER" },
    })

    const response = await refresh(initial.refresh_token)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "The refresh token is invalid, expired, or has been revoked.",
    })
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("revokes the family when a workspace-only membership makes USER mode ineligible", async () => {
    const initial = await firstPair()
    await store.workspaceMember.create({
      data: {
        userId: "user-1",
        role: "MEMBER",
        workspace: {
          id: "ws-2",
          name: "Other workspace",
          slug: "other",
          organization: { id: "org-2", name: "Other org", slug: "other", members: [] },
        },
      },
    })

    const response = await refresh(initial.refresh_token)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_grant")
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it.each([null, "RESEARCH", "agent"])(
    "revokes the family instead of rotating invalid authorizationMode %s",
    async (authorizationMode) => {
      const initial = await firstPair()
      const refreshRow = store.oAuthToken.rows.find(
        (row) => row.tokenHash === hashOAuthToken(initial.refresh_token),
      )
      refreshRow!.authorizationMode = authorizationMode

      const response = await refresh(initial.refresh_token)

      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe("invalid_grant")
      expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
    },
  )
})

describe("request shape", () => {
  it("requires grant_type", async () => {
    const response = await post({ client_id: CLIENT_ID })
    expect((await response.json()).error).toBe("invalid_request")
  })

  it("rejects an unsupported grant_type", async () => {
    const response = await post({ grant_type: "password", client_id: CLIENT_ID })
    expect((await response.json()).error).toBe("unsupported_grant_type")
  })

  it("requires client_id", async () => {
    const response = await post({ grant_type: "authorization_code", code: "x" })
    expect(response.status).toBe(401)
  })

  it("rejects a repeated parameter rather than reading it as absent", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: await issueCode(),
      client_id: CLIENT_ID,
      code_verifier: VERIFIER,
    })
    // Without the duplicate guard, formField reports this as absent and the
    // redirect_uri check against the stored value is skipped entirely.
    body.append("redirect_uri", REDIRECT_URI)
    body.append("redirect_uri", "http://127.0.0.1:1/evil")

    const response = await POST(
      new Request(`${ORIGIN}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_request")
    expect(store.oAuthToken.rows).toHaveLength(0)
  })
})
