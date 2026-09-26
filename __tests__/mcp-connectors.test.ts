/**
 * Unit tests for the outbound MCP connector core (ADR-0018).
 *
 * The properties pinned here are the ones whose failure modes are silent. An
 * encryption round-trip that breaks is loud; a `resource` parameter missing from
 * the *refresh* leg only shows up an hour into a working connection, and a
 * `state` that can be replayed shows up never.
 *
 * The Prisma fakes below honour their `where` clauses rather than returning
 * canned values, because the two store behaviours most worth testing — single-use
 * `state` and compare-and-swap on `generation` — *are* the `where` clause. A mock
 * that ignored it would assert nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { decrypt } from "@/lib/crypto-secrets"
import { McpConnectorError, connectorEncryptionKey } from "@/lib/mcp-connectors/config"
import { discoverConnector, registerConnectorClient } from "@/lib/mcp-connectors/discovery"
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  pickHeaders,
} from "@/lib/mcp-connectors/gateway"
import { outboundFetch, readBoundedText, requireHttpsUrl } from "@/lib/mcp-connectors/http"
import { readConnectorNotice } from "@/lib/mcp-connectors/notice"
import {
  consumeAuthRequest,
  disconnectGrant,
  findGrant,
  listConnectedSlugs,
  rotateGrantTokens,
  saveGrant,
  type ConnectorRecord,
} from "@/lib/mcp-connectors/store"
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshTokens,
} from "@/lib/mcp-connectors/tokens"

/** A real 32-byte base64 key — `lib/crypto-secrets` rejects anything else. */
const KEY = Buffer.alloc(32, 7).toString("base64")

const connector: ConnectorRecord = {
  id: "connector-1",
  slug: "v0",
  origin: "https://compass.example",
  displayName: "v0",
  serverUrl: "https://v0.app/api/mcp",
  resource: "https://v0.app/api/mcp",
  authorizationEndpoint: "https://v0.app/oauth/authorize",
  tokenEndpoint: "https://v0.app/oauth/token",
  revocationEndpoint: "https://v0.app/oauth/revoke",
  scope: "mcp",
  clientId: "client-abc",
  enabled: true,
}

beforeEach(() => {
  vi.stubEnv("MCP_CONNECTOR_SECRET_ENCRYPTION_KEY", KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The `McpConnectorError.code` a call produced, or a marker.
 *
 * `toThrowError` compares an object argument by `message`, so asserting on the
 * code needs the error in hand rather than an asymmetric matcher — and the
 * "<no error>" marker makes a silently-succeeding call fail loudly instead of
 * satisfying a negative assertion by accident.
 */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return "<no error>"
  } catch (error) {
    return error instanceof McpConnectorError ? error.code : `<${String(error)}>`
  }
}

function throwCode(fn: () => unknown): string {
  try {
    fn()
    return "<no error>"
  } catch (error) {
    return error instanceof McpConnectorError ? error.code : `<${String(error)}>`
  }
}

/** Applies a Prisma `data` payload, including `{ increment: n }`. */
function applyUpdate(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      const current = row[key]
      row[key] =
        (typeof current === "number" ? current : 0) + (value as { increment: number }).increment
    } else {
      row[key] = value
    }
  }
}

type Row = Record<string, unknown>

function fakeAuthRequests(seed: Row[] = []) {
  const rows: Row[] = seed.map(row => ({ consumedAt: null, ...row }))
  return {
    rows,
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0
      for (const row of rows) {
        if (row.state !== where.state) continue
        if (where.consumedAt === null && row.consumedAt !== null) continue
        const expires = where.expiresAt as { gt?: Date } | undefined
        if (expires?.gt && !((row.expiresAt as Date) > expires.gt)) continue
        applyUpdate(row, data)
        count++
      }
      return { count }
    }),
    findUnique: vi.fn(
      async ({ where }: { where: Row }) => rows.find(row => row.state === where.state) ?? null,
    ),
  }
}

function matches(row: Row, where: Row): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "connectorId_userId") {
      const composite = value as { connectorId: string; userId: string }
      if (row.connectorId !== composite.connectorId || row.userId !== composite.userId) return false
      continue
    }
    if (row[key] !== value) return false
  }
  return true
}

function fakeGrants(seed: Row[] = []) {
  const rows: Row[] = seed.map(row => ({ ...row }))
  return {
    rows,
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const existing = rows.find(row => matches(row, where))
      if (existing) {
        applyUpdate(existing, update)
        return existing
      }
      const row: Row = {
        id: `grant-${rows.length + 1}`,
        generation: 1,
        accessTokenExpiresAt: null,
        refreshTokenEncrypted: null,
        scope: "mcp",
        ...create,
      }
      rows.push(row)
      return row
    }),
    findUnique: vi.fn(
      async ({ where }: { where: Row }) => rows.find(row => matches(row, where)) ?? null,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0
      for (const row of rows) {
        if (!matches(row, where)) continue
        applyUpdate(row, data)
        count++
      }
      return { count }
    }),
    findMany: vi.fn(async ({ where }: { where: Row }) => rows.filter(row => matches(row, where))),
  }
}

function client(tables: Record<string, unknown>): AppPrismaClient {
  return tables as unknown as AppPrismaClient
}

/** Routes a stubbed `fetch` by URL prefix. An unrouted URL fails the test loudly. */
function routeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = input.toString()
      calls.push({ url, init })
      const key = Object.keys(routes).find(prefix => url.startsWith(prefix))
      if (!key) throw new Error(`unrouted fetch: ${url}`)
      return routes[key]()
    }),
  )
  return calls
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init })
}

// ── Encryption at rest ──────────────────────────────────────────────────────

describe("connector token storage", () => {
  it("round-trips a grant and stores neither token in the clear", async () => {
    const grants = fakeGrants()
    const prisma = client({ mcpConnectorGrant: grants })

    const saved = await saveGrant(
      {
        connectorId: connector.id,
        userId: "user-1",
        accessToken: "v0_access_plaintext",
        refreshToken: "v0_refresh_plaintext",
        accessTokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
        scope: "mcp",
      },
      prisma,
    )
    expect(saved.accessToken).toBe("v0_access_plaintext")

    // The at-rest property, asserted against the stored row rather than the
    // return value: a `saveGrant` that forgot to encrypt would still hand back
    // the right plaintext.
    const stored = grants.rows[0]
    expect(stored.accessTokenEncrypted).not.toContain("plaintext")
    expect(stored.refreshTokenEncrypted).not.toContain("plaintext")
    expect(decrypt(stored.accessTokenEncrypted as string, KEY)).toBe("v0_access_plaintext")

    const read = await findGrant(connector.id, "user-1", prisma)
    expect(read?.accessToken).toBe("v0_access_plaintext")
    expect(read?.refreshToken).toBe("v0_refresh_plaintext")
  })

  it("refuses to store anything when no encryption key is configured", async () => {
    vi.stubEnv("MCP_CONNECTOR_SECRET_ENCRYPTION_KEY", "")
    expect(throwCode(() => connectorEncryptionKey())).toBe("ENCRYPTION_NOT_CONFIGURED")

    const grants = fakeGrants()
    const code = await rejectionCode(
      saveGrant(
        {
          connectorId: connector.id,
          userId: "user-1",
          accessToken: "a",
          refreshToken: null,
          accessTokenExpiresAt: null,
          scope: "mcp",
        },
        client({ mcpConnectorGrant: grants }),
      ),
    )
    expect(code).toBe("ENCRYPTION_NOT_CONFIGURED")
    // Nothing half-written: the key is demanded before the row is touched.
    expect(grants.rows).toHaveLength(0)
  })

  it("does not return a revoked grant, and drops its ciphertext on disconnect", async () => {
    const grants = fakeGrants()
    const prisma = client({ mcpConnectorGrant: grants })
    await saveGrant(
      {
        connectorId: connector.id,
        userId: "user-1",
        accessToken: "live",
        refreshToken: "live-refresh",
        accessTokenExpiresAt: null,
        scope: "mcp",
      },
      prisma,
    )

    expect(await disconnectGrant(connector.id, "user-1", prisma)).toBe(true)
    expect(grants.rows[0].accessTokenEncrypted).toBe("")
    expect(grants.rows[0].refreshTokenEncrypted).toBeNull()
    expect(await findGrant(connector.id, "user-1", prisma)).toBeNull()
    // Idempotent: a second disconnect finds nothing ACTIVE to revoke.
    expect(await disconnectGrant(connector.id, "user-1", prisma)).toBe(false)
  })
})

// ── `state` is single-use ───────────────────────────────────────────────────

describe("consumeAuthRequest", () => {
  const seed: Row = {
    id: "auth-1",
    state: "state-abc",
    connectorId: connector.id,
    userId: "user-1",
    codeVerifier: "verifier",
    redirectUri: "https://compass.example/api/connectors/v0/callback",
    returnTo: "/settings/agents",
    expiresAt: new Date(Date.now() + 60_000),
  }

  it("claims a pending request exactly once", async () => {
    const prisma = client({ mcpConnectorAuthRequest: fakeAuthRequests([seed]) })

    const claimed = await consumeAuthRequest("state-abc", prisma)
    expect(claimed.userId).toBe("user-1")
    expect(claimed.codeVerifier).toBe("verifier")

    // The replay. A read-then-write implementation would hand out the same row
    // again and let one consent be redeemed twice.
    expect(await rejectionCode(consumeAuthRequest("state-abc", prisma))).toBe(
      "INVALID_AUTH_REQUEST",
    )
  })

  it("refuses an expired request", async () => {
    const prisma = client({
      mcpConnectorAuthRequest: fakeAuthRequests([{ ...seed, expiresAt: new Date(Date.now() - 1) }]),
    })
    expect(await rejectionCode(consumeAuthRequest("state-abc", prisma))).toBe(
      "INVALID_AUTH_REQUEST",
    )
  })

  it("refuses a state that was never issued", async () => {
    const prisma = client({ mcpConnectorAuthRequest: fakeAuthRequests([seed]) })
    expect(await rejectionCode(consumeAuthRequest("never-issued", prisma))).toBe(
      "INVALID_AUTH_REQUEST",
    )
  })
})

// ── Refresh compare-and-swap ────────────────────────────────────────────────

describe("rotateGrantTokens", () => {
  async function seeded() {
    const grants = fakeGrants()
    const prisma = client({ mcpConnectorGrant: grants })
    const grant = await saveGrant(
      {
        connectorId: connector.id,
        userId: "user-1",
        accessToken: "old",
        refreshToken: "old-refresh",
        accessTokenExpiresAt: null,
        scope: "mcp",
      },
      prisma,
    )
    return { grants, prisma, grant }
  }

  it("stores rotated tokens when nobody else has written", async () => {
    const { prisma, grant } = await seeded()
    const stored = await rotateGrantTokens(
      {
        grantId: grant.id,
        expectedGeneration: grant.generation,
        accessToken: "new",
        refreshToken: "new-refresh",
        accessTokenExpiresAt: null,
        scope: "mcp",
      },
      prisma,
    )
    expect(stored.accessToken).toBe("new")
    expect(stored.generation).toBe(grant.generation + 1)
  })

  it("yields to the winner of a concurrent refresh instead of clobbering it", async () => {
    const { prisma, grant } = await seeded()

    // The winner refreshes first, taking the row to generation + 1.
    await rotateGrantTokens(
      {
        grantId: grant.id,
        expectedGeneration: grant.generation,
        accessToken: "winner",
        refreshToken: "winner-refresh",
        accessTokenExpiresAt: null,
        scope: "mcp",
      },
      prisma,
    )

    // The loser is still fenced on the generation it read. Its write must land on
    // nothing, and it must come back with the winner's token — not throw, and not
    // overwrite with a refresh token the provider has already rotated away.
    const loser = await rotateGrantTokens(
      {
        grantId: grant.id,
        expectedGeneration: grant.generation,
        accessToken: "loser",
        refreshToken: "loser-refresh",
        accessTokenExpiresAt: null,
        scope: "mcp",
      },
      prisma,
    )
    expect(loser.accessToken).toBe("winner")
    expect(loser.refreshToken).toBe("winner-refresh")
  })

  it("reports GRANT_CHANGED when the grant was disconnected mid-refresh", async () => {
    const { prisma, grant } = await seeded()
    await disconnectGrant(connector.id, "user-1", prisma)
    const code = await rejectionCode(
      rotateGrantTokens(
        {
          grantId: grant.id,
          expectedGeneration: grant.generation,
          accessToken: "new",
          refreshToken: null,
          accessTokenExpiresAt: null,
          scope: "mcp",
        },
        prisma,
      ),
    )
    expect(code).toBe("GRANT_CHANGED")
  })
})

// ── Origin scoping ──────────────────────────────────────────────────────────

describe("listConnectedSlugs", () => {
  it("only reports grants whose connector belongs to this origin", async () => {
    // The hazard this guards: the settings page lists connectors under one origin
    // while the gateway resolves them under another, so a preview branch shows
    // "connected" for a client_id that only exists in production.
    const prisma = client({
      mcpConnectorGrant: fakeGrants([
        { id: "g1", connectorId: "prod-connector", userId: "user-1", status: "ACTIVE" },
        { id: "g2", connectorId: "preview-connector", userId: "user-1", status: "ACTIVE" },
      ]),
      mcpConnector: {
        findMany: vi.fn(
          async ({
            where,
          }: {
            where: { id: { in: string[] }; origin: string; enabled: boolean }
          }) =>
            [
              {
                id: "prod-connector",
                slug: "v0",
                origin: "https://compass.example",
                enabled: true,
              },
              {
                id: "preview-connector",
                slug: "v0",
                origin: "https://preview.example",
                enabled: true,
              },
            ].filter(
              row =>
                where.id.in.includes(row.id) &&
                row.origin === where.origin &&
                row.enabled === where.enabled,
            ),
        ),
      },
    })

    expect(await listConnectedSlugs("user-1", "https://compass.example", prisma)).toEqual(["v0"])
    expect(await listConnectedSlugs("user-1", "https://other.example", prisma)).toEqual([])
  })

  it("reports nothing for a revoked grant, without querying connectors at all", async () => {
    const findMany = vi.fn()
    const prisma = client({
      mcpConnectorGrant: fakeGrants([
        { id: "g1", connectorId: "c1", userId: "user-1", status: "REVOKED" },
      ]),
      mcpConnector: { findMany },
    })
    expect(await listConnectedSlugs("user-1", "https://compass.example", prisma)).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })

  it("treats absent tables as no connectors", async () => {
    // Migration 062 ships after the code, so this is the normal state on a
    // deployment between merge and migrate.
    const prisma = client({
      mcpConnectorGrant: {
        findMany: vi.fn(async () => {
          throw Object.assign(new Error("table does not exist"), { code: "P2021" })
        }),
      },
    })
    expect(await listConnectedSlugs("user-1", "https://compass.example", prisma)).toEqual([])
  })
})

// ── RFC 8707 `resource` on every leg ────────────────────────────────────────

describe("RFC 8707 resource", () => {
  it("is present and identical on authorize, exchange, and refresh", async () => {
    // v0 rejects a request without `resource` with `400 invalid_target`, and it
    // wants the same value each time. Forgetting it on refresh alone produces a
    // connector that works until the first expiry and then dies mid-turn.
    const authorizeUrl = new URL(
      buildAuthorizeUrl(connector, {
        state: "state-abc",
        codeVerifier: "verifier-value",
        redirectUri: "https://compass.example/api/connectors/v0/callback",
      }),
    )

    const calls = routeFetch({
      "https://v0.app/oauth/token": () =>
        json({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }),
    })

    await exchangeAuthorizationCode(connector, {
      code: "code-1",
      codeVerifier: "verifier-value",
      redirectUri: "https://compass.example/api/connectors/v0/callback",
    })
    await refreshTokens(connector, "rt-old")

    const exchangeBody = new URLSearchParams(calls[0].init.body as string)
    const refreshBody = new URLSearchParams(calls[1].init.body as string)

    expect(authorizeUrl.searchParams.get("resource")).toBe(connector.resource)
    expect(exchangeBody.get("resource")).toBe(connector.resource)
    expect(refreshBody.get("resource")).toBe(connector.resource)

    // Public client: `client_id` in the body is the whole of the client
    // authentication, so its absence is as fatal as a missing resource.
    expect(exchangeBody.get("client_id")).toBe(connector.clientId)
    expect(refreshBody.get("client_id")).toBe(connector.clientId)
    expect(exchangeBody.get("grant_type")).toBe("authorization_code")
    expect(exchangeBody.get("code_verifier")).toBe("verifier-value")
    expect(refreshBody.get("grant_type")).toBe("refresh_token")
    expect(refreshBody.get("refresh_token")).toBe("rt-old")
  })

  it("sends a PKCE S256 challenge and never the plain verifier", () => {
    const url = new URL(
      buildAuthorizeUrl(connector, {
        state: "state-abc",
        codeVerifier: "verifier-value",
        redirectUri: "https://compass.example/api/connectors/v0/callback",
      }),
    )
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).not.toBe("verifier-value")
    expect(url.toString()).not.toContain("verifier-value")
    expect(url.searchParams.get("state")).toBe("state-abc")
    expect(url.searchParams.get("scope")).toBe("mcp")
    expect(url.searchParams.get("response_type")).toBe("code")
  })

  it("preserves query parameters already on the authorization endpoint", () => {
    const url = new URL(
      buildAuthorizeUrl(
        { ...connector, authorizationEndpoint: "https://v0.app/oauth/authorize?tenant=acme" },
        { state: "s", codeVerifier: "v", redirectUri: "https://compass.example/cb" },
      ),
    )
    expect(url.searchParams.get("tenant")).toBe("acme")
    expect(url.searchParams.get("client_id")).toBe(connector.clientId)
  })

  it("refuses a non-bearer token rather than presenting it as one", async () => {
    routeFetch({
      "https://v0.app/oauth/token": () => json({ access_token: "at", token_type: "DPoP" }),
    })
    expect(await rejectionCode(refreshTokens(connector, "rt"))).toBe("REFRESH_FAILED")
  })

  it("records the scope the provider actually granted, not the one requested", async () => {
    routeFetch({
      "https://v0.app/oauth/token": () =>
        json({ access_token: "at", token_type: "bearer", scope: "mcp:read" }),
    })
    const tokens = await refreshTokens(connector, "rt")
    expect(tokens.scope).toBe("mcp:read")
    // No `expires_in`: no invented expiry, so the token is used until refused
    // rather than burning a rotating refresh token on a guess.
    expect(tokens.accessTokenExpiresAt).toBeNull()
  })

  it("quotes the provider's error body so `invalid_target` is diagnosable", async () => {
    routeFetch({
      "https://v0.app/oauth/token": () => json({ error: "invalid_target" }, { status: 400 }),
    })
    await expect(
      exchangeAuthorizationCode(connector, {
        code: "c",
        codeVerifier: "v",
        redirectUri: "https://compass.example/cb",
      }),
    ).rejects.toThrowError(/invalid_target/)
  })
})

// ── Outbound HTTP ───────────────────────────────────────────────────────────

describe("outboundFetch", () => {
  it("treats a redirect as a hard failure instead of following it", async () => {
    // Following one on the token endpoint would forward the PKCE verifier and the
    // refresh token to whatever host the redirect named.
    const calls = routeFetch({
      "https://v0.app/oauth/token": () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    })
    expect(await rejectionCode(refreshTokens(connector, "rt"))).toBe("REFRESH_FAILED")
    // One call only: the redirect was refused, not chased.
    expect(calls).toHaveLength(1)
    expect(calls[0].init.redirect).toBe("manual")
    expect(calls[0].init.cache).toBe("no-store")
  })

  it("refuses a 307 on a metadata endpoint too", async () => {
    routeFetch({ "https://v0.app/": () => new Response(null, { status: 307 }) })
    const code = await rejectionCode(
      outboundFetch(
        new URL("https://v0.app/.well-known/oauth-authorization-server"),
        { method: "GET" },
        "DISCOVERY_FAILED",
      ),
    )
    expect(code).toBe("DISCOVERY_FAILED")
  })

  it("rejects a non-HTTPS or credential-bearing endpoint", () => {
    expect(
      throwCode(() => requireHttpsUrl("http://v0.app/t", "token_endpoint", "DISCOVERY_FAILED")),
    ).toBe("DISCOVERY_FAILED")
    expect(() =>
      requireHttpsUrl("http://v0.app/t", "token_endpoint", "DISCOVERY_FAILED"),
    ).toThrowError(/must use HTTPS/)
    expect(() =>
      requireHttpsUrl("https://u:p@v0.app/t", "token_endpoint", "DISCOVERY_FAILED"),
    ).toThrowError(/must not carry credentials/)
    expect(() => requireHttpsUrl("/relative", "token_endpoint", "DISCOVERY_FAILED")).toThrowError(
      /not an absolute URL/,
    )
  })

  it("caps a response body at 64 KiB", async () => {
    const oversized = new Response("x".repeat(70 * 1024))
    expect(await rejectionCode(readBoundedText(oversized, "DISCOVERY_FAILED"))).toBe(
      "DISCOVERY_FAILED",
    )
    // A body inside the cap still reads whole.
    expect(await readBoundedText(new Response("small"), "DISCOVERY_FAILED")).toBe("small")
  })
})

// ── Gateway header allowlists ───────────────────────────────────────────────

describe("pickHeaders", () => {
  it("forwards only the MCP transport headers upstream", () => {
    const source = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "session-9",
      "mcp-protocol-version": "2025-06-18",
      "last-event-id": "42",
      // Everything below must be dropped.
      authorization: "Bearer compass-turn-token",
      cookie: "compass_session=abc",
      "x-vercel-protection-bypass": "a-live-secret",
      "x-forwarded-host": "compass.example",
      "user-agent": "claude-agent-sdk/1",
      referer: "https://compass.example/",
    })

    const picked = pickHeaders(source, FORWARDED_REQUEST_HEADERS)

    expect([...picked.keys()].sort()).toEqual([
      "accept",
      "content-type",
      "last-event-id",
      "mcp-protocol-version",
      "mcp-session-id",
    ])
    expect(picked.get("authorization")).toBeNull()
    expect(picked.get("cookie")).toBeNull()
    expect(picked.get("x-vercel-protection-bypass")).toBeNull()
  })

  it("returns only the safe response headers to the sandbox", () => {
    const source = new Headers({
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "mcp-session-id": "session-9",
      // A forwarded challenge would send the agent SDK off doing OAuth discovery
      // against a Compass path that is not an authorization server for v0.
      "www-authenticate": 'Bearer resource_metadata="https://v0.app/.well-known/x"',
      "set-cookie": "v0_session=abc",
    })

    const picked = pickHeaders(source, FORWARDED_RESPONSE_HEADERS)

    expect(picked.get("www-authenticate")).toBeNull()
    expect(picked.get("set-cookie")).toBeNull()
    expect(picked.get("mcp-session-id")).toBe("session-9")
    expect(picked.get("cache-control")).toBe("no-store")
  })

  it("omits an allowed header that is absent rather than setting it empty", () => {
    const picked = pickHeaders(
      new Headers({ "content-type": "application/json" }),
      FORWARDED_REQUEST_HEADERS,
    )
    expect(picked.has("mcp-session-id")).toBe(false)
  })
})

// ── Discovery ───────────────────────────────────────────────────────────────

describe("discoverConnector", () => {
  const definition = {
    slug: "v0",
    displayName: "v0",
    serverUrl: "https://v0.app/api/mcp",
    fallbackScope: "mcp",
  }

  function challenge(resourceMetadata: string): Response {
    return new Response("unauthorized", {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadata}"` },
    })
  }

  it("reads the pointer from the challenge and validates the issuer", async () => {
    const calls = routeFetch({
      "https://v0.app/api/mcp": () =>
        challenge("https://v0.app/.well-known/oauth-protected-resource"),
      "https://v0.app/.well-known/oauth-protected-resource": () =>
        json({
          resource: "https://v0.app/api/mcp",
          authorization_servers: ["https://v0.app"],
          // v0 really reports this, which is why the AS document supplies the scope.
          scopes_supported: null,
        }),
      "https://v0.app/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://v0.app",
          authorization_endpoint: "https://v0.app/oauth/authorize",
          token_endpoint: "https://v0.app/oauth/token",
          registration_endpoint: "https://v0.app/oauth/register",
          revocation_endpoint: "https://v0.app/oauth/revoke",
          scopes_supported: ["mcp"],
        }),
    })

    const discovered = await discoverConnector(definition)

    expect(discovered.resource).toBe("https://v0.app/api/mcp")
    expect(discovered.tokenEndpoint).toBe("https://v0.app/oauth/token")
    expect(discovered.registrationEndpoint).toBe("https://v0.app/oauth/register")
    expect(discovered.revocationEndpoint).toBe("https://v0.app/oauth/revoke")
    expect(discovered.scope).toBe("mcp")

    // The pointer is read from the challenge, never derived: the RFC 9728 §3.1
    // path-inserted form 404s against v0.
    expect(calls.map(call => call.url)).not.toContain(
      "https://v0.app/.well-known/oauth-protected-resource/api/mcp",
    )
    // And the probe is a real `initialize`, because some servers answer anything
    // else with a challenge-free error.
    expect(JSON.parse(calls[0].init.body as string).method).toBe("initialize")
  })

  it("refuses a resource_metadata pointer on another origin", async () => {
    // A single compromised response would otherwise redirect discovery — and then
    // every user's authorization flow — to an arbitrary host.
    routeFetch({
      "https://v0.app/api/mcp": () => challenge("https://evil.example/.well-known/x"),
    })
    await expect(discoverConnector(definition)).rejects.toThrowError(/not the MCP server's origin/)
  })

  it("refuses an authorization server that advertises a different issuer", async () => {
    routeFetch({
      "https://v0.app/api/mcp": () =>
        challenge("https://v0.app/.well-known/oauth-protected-resource"),
      "https://v0.app/.well-known/oauth-protected-resource": () =>
        json({ resource: "https://v0.app/api/mcp", authorization_servers: ["https://v0.app"] }),
      "https://v0.app/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://someone-else.example",
          authorization_endpoint: "https://v0.app/a",
          token_endpoint: "https://v0.app/t",
        }),
    })
    // Fatal, not a reason to try the OpenID layout next: a host serving somebody
    // else's metadata is the mix-up attack, not a layout difference.
    await expect(discoverConnector(definition)).rejects.toThrowError(/does not match/)
  })

  it("will not guess a metadata URL when the server issues no challenge", async () => {
    routeFetch({ "https://v0.app/api/mcp": () => json({ result: {} }) })
    await expect(discoverConnector(definition)).rejects.toThrowError(/will not guess/)
  })

  it("falls back to the definition's scope only when neither document advertises one", async () => {
    routeFetch({
      "https://v0.app/api/mcp": () =>
        challenge("https://v0.app/.well-known/oauth-protected-resource"),
      "https://v0.app/.well-known/oauth-protected-resource": () =>
        json({ resource: "https://v0.app/api/mcp", authorization_servers: ["https://v0.app"] }),
      "https://v0.app/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://v0.app",
          authorization_endpoint: "https://v0.app/a",
          token_endpoint: "https://v0.app/t",
        }),
    })
    const discovered = await discoverConnector({ ...definition, fallbackScope: "mcp fallback" })
    expect(discovered.scope).toBe("mcp fallback")
    // Absent endpoints stay null rather than being invented.
    expect(discovered.registrationEndpoint).toBeNull()
    expect(discovered.revocationEndpoint).toBeNull()
  })
})

describe("registerConnectorClient", () => {
  const input = {
    registrationEndpoint: "https://v0.app/oauth/register",
    redirectUri: "https://compass.example/api/connectors/v0/callback",
    clientName: "Compass (https://compass.example)",
    scope: "mcp",
  }

  it("registers a public client for exactly one redirect URI", async () => {
    const calls = routeFetch({
      "https://v0.app/oauth/register": () => json({ client_id: "client-xyz" }),
    })

    expect(await registerConnectorClient(input)).toBe("client-xyz")

    const body = JSON.parse(calls[0].init.body as string)
    // `redirect_uri` is matched by exact string at an authorization server, which
    // is the whole reason registrations are keyed per origin.
    expect(body.redirect_uris).toEqual([input.redirectUri])
    expect(body.token_endpoint_auth_method).toBe("none")
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"])
    // The origin is in the client name so a human auditing their v0 account can
    // tell a preview registration from production.
    expect(body.client_name).toContain("https://compass.example")
  })

  it("refuses a confidential client instead of storing a secret with nowhere to live", async () => {
    routeFetch({
      "https://v0.app/oauth/register": () => json({ client_id: "c", client_secret: "shhh" }),
    })
    expect(await rejectionCode(registerConnectorClient(input))).toBe("REGISTRATION_FAILED")
  })

  it("refuses an unusable client_id", async () => {
    routeFetch({ "https://v0.app/oauth/register": () => json({ client_id: "" }) })
    await expect(registerConnectorClient(input)).rejects.toThrowError(/no usable client_id/)
  })
})

// ── The callback → settings-page query contract ─────────────────────────────

describe("readConnectorNotice", () => {
  it("reads the success shape the callback actually writes", () => {
    expect(readConnectorNotice({ connector: "v0", connected: "1" })).toEqual({
      slug: "v0",
      connected: true,
      error: null,
    })
  })

  it("reads the failure param under the name the callback uses", () => {
    // The regression this pins: the callback wrote `connectorError` while the page
    // read `error`, so every failure rendered a silent, message-less page.
    expect(readConnectorNotice({ connector: "v0", connectorError: "WRONG_USER" })).toEqual({
      slug: "v0",
      connected: false,
      error: "WRONG_USER",
    })
  })

  it("never renders success alongside an error", () => {
    expect(
      readConnectorNotice({
        connector: "v0",
        connected: "1",
        connectorError: "TOKEN_EXCHANGE_FAILED",
      }),
    ).toEqual({ slug: "v0", connected: false, error: "TOKEN_EXCHANGE_FAILED" })
  })

  it("ignores an unknown connector and a hostile error code", () => {
    expect(readConnectorNotice({ connector: "not-a-connector", connected: "1" })).toBeNull()
    expect(
      readConnectorNotice({ connector: "v0", connectorError: "<script>alert(1)</script>" })?.error,
    ).toBeNull()
    expect(readConnectorNotice({ connector: "v0", connectorError: "x".repeat(65) })?.error).toBeNull()
    // Repeated params arrive as arrays; neither is trusted.
    expect(readConnectorNotice({ connector: ["v0", "v0"] })).toBeNull()
    expect(readConnectorNotice({})).toBeNull()
  })
})

describe("McpConnectorError", () => {
  it("defaults its message to the code so a bare throw is still legible in a log", () => {
    expect(new McpConnectorError("NOT_CONNECTED").message).toBe("NOT_CONNECTED")
    expect(new McpConnectorError("NOT_CONNECTED").name).toBe("McpConnectorError")
  })
})
