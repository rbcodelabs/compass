/**
 * Authorization codes, and specifically the one property everything else rests
 * on: **a code is consumed exactly once, even under concurrency.**
 *
 * The fake store in __tests__/helpers/oauth-store.ts implements `updateMany`
 * with real predicate evaluation and a microtask yield before it mutates, so a
 * read-then-write implementation of `claimAuthorizationCode` double-spends here
 * and these tests go red. That is the whole reason it exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createOAuthStore } from "../helpers/oauth-store"

// The factory reads `store` lazily — it runs when @/lib/db is first imported,
// and the arrow it returns is not called until a test invokes getPrisma().
const store = createOAuthStore()
vi.mock("@/lib/db", () => ({ default: () => store.prisma }))

import { AUTHORIZATION_CODE_TTL_MS, claimAuthorizationCode, issueAuthorizationCode } from "@/lib/oauth/codes"
import { AUTHORIZATION_CODE_PREFIX, hashOAuthToken } from "@/lib/oauth/tokens"

const REQUEST = {
  clientId: "cmp_oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  userId: "user-1",
  redirectUri: "http://127.0.0.1:54321/callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  scope: "mcp:read mcp:write",
  resource: "https://compass.example.com/api/mcp",
}

beforeEach(() => store.reset())

describe("issueAuthorizationCode", () => {
  it("returns a cmp_oac_ code and stores only its hash", async () => {
    const { code, expiresAt } = await issueAuthorizationCode(REQUEST, new Date("2026-09-18T12:00:00Z"))

    expect(code.startsWith(AUTHORIZATION_CODE_PREFIX)).toBe(true)
    expect(expiresAt.getTime()).toBe(new Date("2026-09-18T12:00:00Z").getTime() + AUTHORIZATION_CODE_TTL_MS)

    const [row] = store.oAuthAuthorizationCode.rows
    expect(row.codeHash).toBe(hashOAuthToken(code))
    // The bearer value itself must not be recoverable from the row.
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it("issues a 60-second TTL", () => {
    expect(AUTHORIZATION_CODE_TTL_MS).toBe(60_000)
  })
})

describe("claimAuthorizationCode", () => {
  it("returns the stored request on the first claim", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)
    const claim = await claimAuthorizationCode(code)

    expect(claim.ok).toBe(true)
    if (!claim.ok) return
    expect(claim.code.userId).toBe("user-1")
    expect(claim.code.redirectUri).toBe(REQUEST.redirectUri)
    expect(claim.code.codeChallenge).toBe(REQUEST.codeChallenge)
    expect(claim.code.scope).toBe(REQUEST.scope)
    expect(claim.code.resource).toBe(REQUEST.resource)
  })

  it("reports a second claim as a replay, carrying the family to revoke", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)
    const first = await claimAuthorizationCode(code)
    const second = await claimAuthorizationCode(code)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!first.ok || second.ok || second.reason !== "replayed") {
      throw new Error("expected the first claim to win and the second to be a replay")
    }
    // The family id is the code's own row id, which is what lets the token
    // endpoint revoke everything the leaked code produced.
    expect(second.familyId).toBe(first.code.id)
  })

  it("reports an unknown code as unknown, with no family to revoke", async () => {
    const claim = await claimAuthorizationCode(`${AUTHORIZATION_CODE_PREFIX}${"0".repeat(32)}`)
    expect(claim).toEqual({ ok: false, reason: "unknown" })
  })

  it("marks the row consumed rather than deleting it, so a replay is detectable", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)
    await claimAuthorizationCode(code, new Date("2026-09-18T12:00:30Z"))

    const [row] = store.oAuthAuthorizationCode.rows
    expect(row.consumedAt).toEqual(new Date("2026-09-18T12:00:30Z"))
  })

  it("does not mutate a row it did not claim", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)
    const other = await issueAuthorizationCode({ ...REQUEST, userId: "user-2" })
    await claimAuthorizationCode(code)

    const untouched = store.oAuthAuthorizationCode.rows.find(
      (row) => row.codeHash === hashOAuthToken(other.code),
    )
    expect(untouched?.consumedAt).toBeNull()
  })

  // ── the load-bearing one ────────────────────────────────────────────────
  it("lets exactly one of two concurrent claims win", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)

    const [a, b] = await Promise.all([claimAuthorizationCode(code), claimAuthorizationCode(code)])

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    const loser = a.ok ? b : a
    expect(loser.ok).toBe(false)
    if (loser.ok) return
    expect(["replayed", "conflict"]).toContain(loser.reason)
  })

  it("lets exactly one of ten concurrent claims win", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)

    const claims = await Promise.all(
      Array.from({ length: 10 }, () => claimAuthorizationCode(code)),
    )

    expect(claims.filter((claim) => claim.ok)).toHaveLength(1)
  })

  it("treats a database write conflict as a lost claim, not a crash", async () => {
    const { code } = await issueAuthorizationCode(REQUEST)
    // Aurora DSQL aborts the loser of a concurrent write with OC001 rather than
    // serialising it, so the conflict can surface as a throw instead of count 0.
    store.oAuthAuthorizationCode.updateMany.mockRejectedValueOnce(
      Object.assign(new Error("OC001: change conflicts with another transaction"), { code: "OC001" }),
    )

    const claim = await claimAuthorizationCode(code)
    expect(claim).toEqual({ ok: false, reason: "conflict" })
  })
})
