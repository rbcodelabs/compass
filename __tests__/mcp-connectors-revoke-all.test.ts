/**
 * Emergency bulk revocation of connector grants: lib/mcp-connectors/revoke-all.ts
 * and the POST /api/admin/revoke-connector-grants route (ADR-0018).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { encrypt } from "@/lib/crypto-secrets"
import type { AppPrismaClient } from "@/lib/db"

const db = vi.hoisted(() => ({ prisma: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => db.prisma }))

import { revokeAllConnectorGrants } from "@/lib/mcp-connectors/revoke-all"
import { resetMcpConnectorsAvailabilityCache } from "@/lib/mcp-connectors/store"
import { POST } from "@/app/api/admin/revoke-connector-grants/route"

const KEY = Buffer.alloc(32, 7).toString("base64")
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64")

type Row = Record<string, unknown>

/** Honors the subset of Prisma `where` the module uses: equality, `in`, `not`. */
function matches(row: Row, where: Row): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; not?: unknown }
      if (c.in && !c.in.includes(row[field])) return false
      if ("not" in c && row[field] === c.not) return false
    } else if (row[field] !== condition) return false
  }
  return true
}

function fakePrisma(connectors: Row[], grants: Row[]) {
  const grantRows: Row[] = grants.map(row => ({ generation: 1, ...row }))
  const grantTable = {
    rows: grantRows,
    findFirst: vi.fn(async () => null),
    count: vi.fn(async ({ where }: { where: Row }) => grantRows.filter(row => matches(row, where)).length),
    findMany: vi.fn(async ({ where, take }: { where: Row; take?: number }) =>
      grantRows
        .filter(row => matches(row, where))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, take),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0
      for (const row of grantRows) {
        if (!matches(row, where)) continue
        for (const [field, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value)
            row[field] = (row[field] as number) + (value as { increment: number }).increment
          else row[field] = value
        }
        count++
      }
      return { count }
    }),
  }
  const prisma = {
    mcpConnector: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: Row }) => connectors.filter(row => matches(row, where))),
    },
    mcpConnectorGrant: grantTable,
    mcpConnectorAuthRequest: { findFirst: vi.fn(async () => null) },
  }
  db.prisma = prisma
  return { prisma: prisma as unknown as AppPrismaClient, grantTable }
}

const drive: Row = {
  id: "c-drive",
  slug: "google-drive",
  origin: "https://compass.example",
  displayName: "Google Drive",
  serverUrl: "https://drivemcp.googleapis.com/mcp/v1",
  resource: "https://drivemcp.googleapis.com/mcp/v1",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  scope: "drive",
  clientId: "google-client",
  enabled: true,
}
const v0: Row = {
  ...drive,
  id: "c-v0",
  slug: "v0",
  displayName: "v0",
  revocationEndpoint: null,
  clientId: "v0-client",
}

function grant(id: string, connectorId: string, userId: string, key = KEY, extra: Row = {}): Row {
  return {
    id,
    connectorId,
    userId,
    accessTokenEncrypted: encrypt(`access-${id}`, key),
    refreshTokenEncrypted: encrypt(`refresh-${id}`, key),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    scope: "drive",
    status: "ACTIVE",
    ...extra,
  }
}

function stubRevokeEndpoint(status = 200) {
  const bodies: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL | string, init: RequestInit = {}) => {
      bodies.push(String(init.body))
      return new Response("", { status })
    }),
  )
  return bodies
}

beforeEach(() => {
  resetMcpConnectorsAvailabilityCache()
  vi.stubEnv("MCP_CONNECTOR_SECRET_ENCRYPTION_KEY", KEY)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("revokeAllConnectorGrants", () => {
  it("dry run counts grants per connector and changes nothing", async () => {
    const { prisma, grantTable } = fakePrisma(
      [drive, v0],
      [grant("g1", "c-drive", "u1"), grant("g2", "c-drive", "u2"), grant("g3", "c-v0", "u1")],
    )
    const bodies = stubRevokeEndpoint()

    const result = await revokeAllConnectorGrants({ dryRun: true }, prisma)

    expect(result.matched).toBe(3)
    expect(result.wiped).toBe(0)
    expect(result.remaining).toBe(3)
    expect(result.byConnector).toEqual([
      { slug: "google-drive", origin: "https://compass.example", grants: 2, providerRevocation: true },
      { slug: "v0", origin: "https://compass.example", grants: 1, providerRevocation: false },
    ])
    expect(grantTable.updateMany).not.toHaveBeenCalled()
    expect(bodies).toHaveLength(0)
    expect(grantTable.rows.every(row => row.status === "ACTIVE")).toBe(true)
  })

  it("wipes every grant, bumps generation, and revokes the refresh token at the provider", async () => {
    const { prisma, grantTable } = fakePrisma([drive], [grant("g1", "c-drive", "u1"), grant("g2", "c-drive", "u2")])
    const bodies = stubRevokeEndpoint()

    const result = await revokeAllConnectorGrants({ dryRun: false }, prisma)

    expect(result).toMatchObject({ matched: 2, wiped: 2, providerRevoked: 2, undecryptable: 0, remaining: 0, truncated: false })
    for (const row of grantTable.rows) {
      expect(row).toMatchObject({ status: "REVOKED", accessTokenEncrypted: "", refreshTokenEncrypted: null, generation: 2 })
    }
    // Refresh token preferred: revoking it also kills the access tokens it minted.
    expect(bodies.some(body => body.includes("token=refresh-g1"))).toBe(true)
    expect(bodies.some(body => body.includes("token=access-g1"))).toBe(false)
  })

  it("wipes locally even when the provider has no revocation endpoint or refuses", async () => {
    const { prisma, grantTable } = fakePrisma([v0, drive], [grant("g1", "c-v0", "u1"), grant("g2", "c-drive", "u2")])
    stubRevokeEndpoint(503)

    const result = await revokeAllConnectorGrants({ dryRun: false }, prisma)

    expect(result).toMatchObject({ wiped: 2, providerRevoked: 0, providerNotConfirmed: 2, remaining: 0 })
    expect(grantTable.rows.every(row => row.status === "REVOKED")).toBe(true)
  })

  it("wipes grants whose ciphertext will not open and reports them, without calling the provider", async () => {
    const { prisma, grantTable } = fakePrisma([drive], [grant("g1", "c-drive", "u1", OTHER_KEY), grant("g2", "c-drive", "u2")])
    const bodies = stubRevokeEndpoint()

    const result = await revokeAllConnectorGrants({ dryRun: false }, prisma)

    expect(result).toMatchObject({ wiped: 2, providerRevoked: 1, undecryptable: 1, remaining: 0 })
    expect(bodies).toHaveLength(1)
    expect(grantTable.rows.every(row => row.accessTokenEncrypted === "")).toBe(true)
  })

  it("still wipes everything when the encryption key is no longer configured", async () => {
    const { prisma, grantTable } = fakePrisma([drive], [grant("g1", "c-drive", "u1")])
    vi.stubEnv("MCP_CONNECTOR_SECRET_ENCRYPTION_KEY", "")
    const bodies = stubRevokeEndpoint()

    const result = await revokeAllConnectorGrants({ dryRun: false }, prisma)

    expect(result).toMatchObject({ encryptionKeyConfigured: false, wiped: 1, undecryptable: 1, providerRevoked: 0 })
    expect(bodies).toHaveLength(0)
    expect(grantTable.rows[0].status).toBe("REVOKED")
  })

  it("scopes to one slug and one user", async () => {
    const { prisma, grantTable } = fakePrisma(
      [drive, v0],
      [grant("g1", "c-drive", "u1"), grant("g2", "c-drive", "u2"), grant("g3", "c-v0", "u1")],
    )
    stubRevokeEndpoint()

    const result = await revokeAllConnectorGrants({ dryRun: false, slug: "google-drive", userId: "u1" }, prisma)

    expect(result).toMatchObject({ matched: 1, wiped: 1, remaining: 0 })
    const status = Object.fromEntries(grantTable.rows.map(row => [row.id, row.status]))
    expect(status).toEqual({ g1: "REVOKED", g2: "ACTIVE", g3: "ACTIVE" })
  })

  it("also sweeps NEEDS_REAUTH grants and skips ones already revoked", async () => {
    const { prisma } = fakePrisma(
      [drive],
      [
        grant("g1", "c-drive", "u1", KEY, { status: "NEEDS_REAUTH" }),
        grant("g2", "c-drive", "u2", KEY, { status: "REVOKED", accessTokenEncrypted: "", refreshTokenEncrypted: null }),
      ],
    )
    stubRevokeEndpoint()

    const result = await revokeAllConnectorGrants({ dryRun: false }, prisma)

    expect(result).toMatchObject({ matched: 1, wiped: 1 })
  })

  it("is resumable: a deadline stops it early, reports what is left, and a second run finishes", async () => {
    const grants = Array.from({ length: 30 }, (_, i) => grant(`g${String(i).padStart(2, "0")}`, "c-drive", `u${i}`))
    const { prisma } = fakePrisma([drive], grants)
    stubRevokeEndpoint()

    // A deadline of 0 ms never starts a chunk, so the first run is a pure "truncated" report.
    const first = await revokeAllConnectorGrants({ dryRun: false, deadlineMs: 0 }, prisma)
    expect(first).toMatchObject({ wiped: 0, remaining: 30, truncated: true })

    const second = await revokeAllConnectorGrants({ dryRun: false }, prisma)
    expect(second).toMatchObject({ matched: 30, wiped: 30, remaining: 0, truncated: false })
  })

  it("reports nothing to do when the connector tables do not exist yet", async () => {
    const { prisma } = fakePrisma([drive], [])
    ;(prisma.mcpConnector.findFirst as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("missing"), { code: "P2021" }),
    )

    const result = await revokeAllConnectorGrants({ dryRun: false }, prisma)

    expect(result).toMatchObject({ available: false, matched: 0, wiped: 0 })
  })
})

describe("POST /api/admin/revoke-connector-grants", () => {
  const SECRET = "test-migration-secret"

  function request(body: unknown, secret?: string) {
    return new NextRequest("http://localhost/api/admin/revoke-connector-grants", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...(secret ? { "x-migration-secret": secret } : {}) },
    })
  }

  beforeEach(() => {
    vi.stubEnv("MIGRATION_SECRET", SECRET)
  })

  it("rejects a missing or wrong secret and touches nothing", async () => {
    const { grantTable } = fakePrisma([drive], [grant("g1", "c-drive", "u1")])

    expect((await POST(request({ dryRun: false }))).status).toBe(401)
    expect((await POST(request({ dryRun: false }, "wrong"))).status).toBe(401)
    expect(grantTable.updateMany).not.toHaveBeenCalled()
  })

  it("rejects everything when MIGRATION_SECRET is not configured", async () => {
    vi.stubEnv("MIGRATION_SECRET", "")
    fakePrisma([drive], [])
    expect((await POST(request({}, ""))).status).toBe(401)
    expect((await POST(request({}, "anything"))).status).toBe(401)
  })

  it("defaults to a dry run, including on an empty or unparseable body", async () => {
    const { grantTable } = fakePrisma([drive], [grant("g1", "c-drive", "u1")])

    const empty = await POST(request("not json", SECRET))
    const explicitTrue = await POST(request({ dryRun: "yes" }, SECRET))

    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ dryRun: true, matched: 1, wiped: 0 })
    expect((await explicitTrue.json()).wiped).toBe(0)
    expect(grantTable.updateMany).not.toHaveBeenCalled()
  })

  it("writes only on an explicit dryRun:false, and the response carries counts, not tokens", async () => {
    const { grantTable } = fakePrisma([drive], [grant("g1", "c-drive", "u1")])
    stubRevokeEndpoint()

    const response = await POST(request({ dryRun: false }, SECRET))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ dryRun: false, wiped: 1, providerRevoked: 1, remaining: 0 })
    expect(text).not.toMatch(/refresh-g1|access-g1|u1/)
    expect(grantTable.rows[0].status).toBe("REVOKED")
  })

  it("rejects a malformed slug or userId", async () => {
    fakePrisma([drive], [])
    expect((await POST(request({ slug: 42 }, SECRET))).status).toBe(400)
    expect((await POST(request({ userId: "   " }, SECRET))).status).toBe(400)
  })
})
