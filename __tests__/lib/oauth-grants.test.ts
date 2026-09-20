/**
 * Refresh-token rotation, reuse detection, and family revocation.
 *
 * The property under test is: **a refresh token works exactly once, and
 * presenting a rotated one takes the whole family down.** The second half is
 * what makes rotation worth having — without it, an attacker who steals a
 * refresh token simply refreshes alongside the legitimate client forever, and
 * neither side ever notices.
 *
 * As in oauth-codes.test.ts, the fake store implements `updateMany` with real
 * predicate evaluation and a yield before mutating, so a read-then-write
 * rotation fails the concurrency cases here rather than passing them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "../helpers/oauth-store"

const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  claimRefreshToken,
  findRevocationTarget,
  issueTokenPair,
  revokeTokenById,
  revokeTokenFamily,
} from "@/lib/oauth/grants"
import { hashOAuthToken } from "@/lib/oauth/tokens"

const GRANT = {
  clientId: "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  userId: "user-1",
  scope: "mcp:read mcp:write",
  resource: "https://compass.example.com/api/mcp",
  familyId: "code-00000001",
}

beforeEach(() => store.reset())

describe("issueTokenPair", () => {
  it("always issues a refresh token, with or without offline_access", async () => {
    const withoutOffline = await issueTokenPair(GRANT)
    expect(withoutOffline.refresh_token).toMatch(/^cmp_ort_[0-9a-f]{32}$/)
    expect(withoutOffline.access_token).toMatch(/^cmp_oat_[0-9a-f]{32}$/)
    expect(withoutOffline.token_type).toBe("Bearer")

    store.reset()
    const withOffline = await issueTokenPair({ ...GRANT, scope: "mcp:read offline_access" })
    expect(withOffline.refresh_token).toMatch(/^cmp_ort_[0-9a-f]{32}$/)
  })

  it("stores only hashes, never the bearer values", async () => {
    const tokens = await issueTokenPair(GRANT)
    const serialized = JSON.stringify(store.oAuthToken.rows)

    expect(serialized).not.toContain(tokens.access_token)
    expect(serialized).not.toContain(tokens.refresh_token)
    expect(store.oAuthToken.rows.map((row) => row.tokenHash).sort()).toEqual(
      [hashOAuthToken(tokens.access_token), hashOAuthToken(tokens.refresh_token)].sort(),
    )
  })

  it("binds both tokens to the same family, audience and scope", async () => {
    await issueTokenPair(GRANT)
    for (const row of store.oAuthToken.rows) {
      expect(row.familyId).toBe(GRANT.familyId)
      expect(row.resource).toBe(GRANT.resource)
      expect(row.scope).toBe(GRANT.scope)
      expect(row.userId).toBe("user-1")
      // Null = every workspace the user belongs to (decision 1).
      expect(row.scopeWorkspaceId).toBeNull()
    }
  })

  it("gives the access and refresh tokens their configured lifetimes", async () => {
    const now = new Date("2026-09-18T12:00:00Z")
    const tokens = await issueTokenPair(GRANT, now)

    expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_MS / 1000)
    const access = store.oAuthToken.rows.find((row) => row.type === "ACCESS")
    const refresh = store.oAuthToken.rows.find((row) => row.type === "REFRESH")
    expect(access?.expiresAt).toEqual(new Date(now.getTime() + ACCESS_TOKEN_TTL_MS))
    expect(refresh?.expiresAt).toEqual(new Date(now.getTime() + REFRESH_TOKEN_TTL_MS))
  })
})

describe("claimRefreshToken", () => {
  async function issue(overrides: Partial<typeof GRANT> = {}) {
    const tokens = await issueTokenPair({ ...GRANT, ...overrides })
    return { tokens, hash: hashOAuthToken(tokens.refresh_token) }
  }

  it("rotates the token out of service and returns the grant it carried", async () => {
    const { hash } = await issue()
    const claim = await claimRefreshToken(hash, new Date("2026-09-18T13:00:00Z"))

    expect(claim.ok).toBe(true)
    if (!claim.ok) return
    expect(claim.token.userId).toBe("user-1")
    expect(claim.token.scope).toBe("mcp:read mcp:write")
    expect(claim.token.familyId).toBe(GRANT.familyId)

    const row = store.oAuthToken.rows.find((candidate) => candidate.tokenHash === hash)
    expect(row?.revokedAt).toEqual(new Date("2026-09-18T13:00:00Z"))
  })

  it("rejects an unknown token", async () => {
    expect(await claimRefreshToken(hashOAuthToken("cmp_ort_" + "0".repeat(32)))).toEqual({
      ok: false,
      reason: "unknown",
    })
  })

  it("refuses to treat an access token as a refresh token", async () => {
    const tokens = await issueTokenPair(GRANT)
    expect(await claimRefreshToken(hashOAuthToken(tokens.access_token))).toEqual({
      ok: false,
      reason: "unknown",
    })
  })

  it("rejects an expired token without revoking the family", async () => {
    const { hash } = await issue()
    const claim = await claimRefreshToken(hash, new Date(Date.now() + REFRESH_TOKEN_TTL_MS + 1000))

    expect(claim).toEqual({ ok: false, reason: "expired" })
    // An expiry is ordinary lifecycle, not evidence of compromise — the access
    // token in the same family stays as it was.
    const access = store.oAuthToken.rows.find((row) => row.type === "ACCESS")
    expect(access?.revokedAt).toBeNull()
  })

  // ── reuse detection ─────────────────────────────────────────────────────
  it("revokes the entire family when a rotated token is replayed", async () => {
    const { hash } = await issue()
    const first = await claimRefreshToken(hash)
    expect(first.ok).toBe(true)

    // Rotate once legitimately, so the family has a second generation to lose.
    const second = await issueTokenPair({ ...GRANT, parentTokenId: "token-00000002" })
    const replay = await claimRefreshToken(hash)

    expect(replay.ok).toBe(false)
    if (replay.ok) return
    expect(replay.reason).toBe("reused")

    // Everything in the family, including the generation issued after the
    // rotation, is now dead — that generation is what an attacker would hold.
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
    const rotated = store.oAuthToken.rows.find(
      (row) => row.tokenHash === hashOAuthToken(second.refresh_token),
    )
    expect(rotated?.revokedAt).not.toBeNull()
  })

  it("does not touch a different family when one is revoked for reuse", async () => {
    const { hash } = await issue()
    await issueTokenPair({ ...GRANT, familyId: "code-00000099" })
    await claimRefreshToken(hash)
    await claimRefreshToken(hash)

    const other = store.oAuthToken.rows.filter((row) => row.familyId === "code-00000099")
    expect(other).toHaveLength(2)
    expect(other.every((row) => row.revokedAt === null)).toBe(true)
  })

  it("lets exactly one of two concurrent rotations win, and kills the family", async () => {
    const { hash } = await issue()

    const [a, b] = await Promise.all([claimRefreshToken(hash), claimRefreshToken(hash)])

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    if (loser.ok) throw new Error("expected one rotation to lose")
    expect(loser.reason).toBe("reused")
    // A genuinely concurrent double-refresh is indistinguishable from a replay,
    // and is treated as one: re-authorizing costs a click, a live stolen token
    // costs everything.
    expect(store.oAuthToken.rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  it("treats a database write conflict as reuse", async () => {
    const { hash } = await issue()
    store.oAuthToken.updateMany.mockImplementationOnce(async () => {
      throw Object.assign(new Error("OC001"), { code: "OC001" })
    })

    const claim = await claimRefreshToken(hash)
    expect(claim.ok).toBe(false)
    if (claim.ok) return
    expect(claim.reason).toBe("reused")
  })
})

describe("revokeTokenFamily", () => {
  it("is idempotent", async () => {
    await issueTokenPair(GRANT)
    expect(await revokeTokenFamily(GRANT.familyId)).toBe(2)
    expect(await revokeTokenFamily(GRANT.familyId)).toBe(0)
  })
})

describe("findRevocationTarget / revokeTokenById", () => {
  it("finds a token by hash and revokes only that row", async () => {
    const tokens = await issueTokenPair(GRANT)
    const target = await findRevocationTarget(hashOAuthToken(tokens.access_token))

    expect(target.found).toBe(true)
    if (!target.found) return
    expect(target.type).toBe("ACCESS")
    expect(target.clientId).toBe(GRANT.clientId)

    await revokeTokenById(target.id)
    const refresh = store.oAuthToken.rows.find((row) => row.type === "REFRESH")
    // Dropping one access token is not a request to end the whole grant.
    expect(refresh?.revokedAt).toBeNull()
  })

  it("reports an unknown hash as not found", async () => {
    expect(await findRevocationTarget("0".repeat(64))).toEqual({ found: false })
  })
})
