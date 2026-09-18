/**
 * `POST /api/oauth/revoke` — RFC 7009.
 *
 * Two things are being pinned here, and the second is counter-intuitive enough
 * to be worth stating:
 *
 *  1. A **public client** — `client_id`, no secret — can revoke its own tokens.
 *     That is exactly what the Geode broker posts.
 *  2. Almost everything answers 200, including an unknown or already-revoked
 *     token. RFC 7009 §2.2 requires it, because a distinguishable response
 *     turns an unauthenticated endpoint into a token oracle: an attacker
 *     holding a candidate value could learn whether it is live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "./helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import { POST } from "@/app/api/oauth/revoke/route"
import { issueTokenPair } from "@/lib/oauth/grants"
import { hashOAuthToken } from "@/lib/oauth/tokens"

const ORIGIN = "https://compass.example.com"
const CLIENT_ID = "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OTHER_CLIENT_ID = "cmp_oc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function revoke(fields: Record<string, string>) {
  return POST(
    new Request(`${ORIGIN}/api/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  )
}

async function registerClient(clientId = CLIENT_ID, overrides: Record<string, unknown> = {}) {
  await store.oAuthClient.create({
    data: {
      clientId,
      clientName: "Agent Threads",
      redirectUris: ["http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      scope: "mcp:read mcp:write",
      tokenEndpointAuthMethod: "none",
      ...overrides,
    },
  })
}

const grant = (clientId = CLIENT_ID) =>
  issueTokenPair({
    clientId,
    userId: "user-1",
    scope: "mcp:read mcp:write",
    resource: `${ORIGIN}/api/mcp`,
    familyId: `code-${clientId.slice(-4)}`,
  })

const rowFor = (token: string) =>
  store.oAuthToken.rows.find((row) => row.tokenHash === hashOAuthToken(token))

beforeEach(async () => {
  store.reset()
  vi.stubEnv("VERCEL_ENV", "")
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN)
  await registerClient()
})
afterEach(() => vi.unstubAllEnvs())

describe("a public client revoking its own tokens", () => {
  it("revokes a refresh token and the access tokens issued alongside it", async () => {
    const tokens = await grant()
    const response = await revoke({
      token: tokens.refresh_token,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    })

    expect(response.status).toBe(200)
    // RFC 7009 §2.1: revoking a refresh token SHOULD revoke what it produced.
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("revokes an access token without ending the whole grant", async () => {
    const tokens = await grant()
    await revoke({ token: tokens.access_token, client_id: CLIENT_ID })

    expect(rowFor(tokens.access_token)?.revokedAt).not.toBeNull()
    // Dropping one short-lived credential is not a request to sign out.
    expect(rowFor(tokens.refresh_token)?.revokedAt).toBeNull()
  })

  it("needs no client_secret", async () => {
    const tokens = await grant()
    expect((await revoke({ token: tokens.access_token, client_id: CLIENT_ID })).status).toBe(200)
  })

  it("ignores a wrong token_type_hint, which is advisory only", async () => {
    const tokens = await grant()
    const response = await revoke({
      token: tokens.access_token,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    })
    expect(response.status).toBe(200)
    expect(rowFor(tokens.access_token)?.revokedAt).not.toBeNull()
  })

  it("is idempotent", async () => {
    const tokens = await grant()
    await revoke({ token: tokens.refresh_token, client_id: CLIENT_ID })
    expect((await revoke({ token: tokens.refresh_token, client_id: CLIENT_ID })).status).toBe(200)
  })
})

describe("the 200-for-everything rule", () => {
  it("answers 200 for an unknown token", async () => {
    const response = await revoke({ token: `cmp_oat_${"0".repeat(32)}`, client_id: CLIENT_ID })
    expect(response.status).toBe(200)
  })

  it("answers 200 for a value that is not a Compass token at all", async () => {
    expect((await revoke({ token: "github_pat_whatever", client_id: CLIENT_ID })).status).toBe(200)
  })

  it("answers 200 — and revokes nothing — for another client's token", async () => {
    await registerClient(OTHER_CLIENT_ID)
    const tokens = await grant(OTHER_CLIENT_ID)

    const response = await revoke({ token: tokens.refresh_token, client_id: CLIENT_ID })
    expect(response.status).toBe(200)
    // Otherwise any registered client could revoke any other's tokens by guessing.
    expect(rowFor(tokens.refresh_token)?.revokedAt).toBeNull()
  })

  it("returns an empty body, so nothing distinguishes the cases", async () => {
    const tokens = await grant()
    const real = await revoke({ token: tokens.access_token, client_id: CLIENT_ID })
    const fake = await revoke({ token: `cmp_oat_${"0".repeat(32)}`, client_id: CLIENT_ID })

    expect(await real.text()).toBe("")
    expect(await fake.text()).toBe("")
    expect(real.status).toBe(fake.status)
  })
})

describe("the two cases RFC 7009 does not paper over", () => {
  it("400s when token is missing", async () => {
    const response = await revoke({ client_id: CLIENT_ID })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe("invalid_request")
  })

  it("401s on client authentication failure", async () => {
    // The client needs to know its own credentials are wrong, rather than
    // believing a token was revoked when it was not.
    const tokens = await grant()
    const noClient = await revoke({ token: tokens.access_token })
    expect(noClient.status).toBe(401)

    const unknownClient = await revoke({ token: tokens.access_token, client_id: "cmp_oc_nope" })
    expect(unknownClient.status).toBe(401)

    expect(rowFor(tokens.access_token)?.revokedAt).toBeNull()
  })

  it("401s when a confidential client presents the wrong secret", async () => {
    store.reset()
    await registerClient(CLIENT_ID, {
      tokenEndpointAuthMethod: "client_secret_post",
      clientSecretHash: hashOAuthToken("cmp_ocs_right"),
    })
    const tokens = await grant()

    expect((await revoke({ token: tokens.access_token, client_id: CLIENT_ID })).status).toBe(401)
    expect(
      (await revoke({ token: tokens.access_token, client_id: CLIENT_ID, client_secret: "cmp_ocs_right" }))
        .status,
    ).toBe(200)
  })
})
