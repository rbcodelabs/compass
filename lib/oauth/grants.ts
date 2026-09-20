/**
 * Token issuance, refresh rotation, reuse detection, and revocation.
 *
 * ## Families
 *
 * Every token descends from the authorization code that started the flow, and
 * `OAuthToken.familyId` is **that code's row id**. This is not an arbitrary
 * grouping key: it is what makes two otherwise-separate requirements fall out
 * of one column.
 *
 *  - *Refresh rotation with reuse detection* — a rotated refresh token that is
 *    presented again revokes the whole family, because a replay means either
 *    the client is broken or the token leaked, and there is no way to tell
 *    which from the request. Erring toward revocation costs a re-authorization;
 *    erring the other way leaves an attacker holding a live credential.
 *  - *Authorization-code replay* — OAuth 2.1 §4.1.3 says a second exchange of
 *    an already-consumed code SHOULD revoke the tokens it produced. Because the
 *    family id *is* the code id, the token endpoint can do that knowing only
 *    the replayed code.
 *
 * ## Refresh tokens are unconditional
 *
 * A refresh token is issued for **every** authorization-code grant, never
 * gated on an `offline_access` scope. The Geode broker requests the
 * `refresh_token` grant at registration but does not append `offline_access` to
 * its scope string, and its proxy depends on refresh to recover from an
 * upstream 401 — gating would leave every Geode user re-authorizing by hand on
 * expiry. `offline_access` is still advertised in the AS metadata because
 * Claude gates its *request* for a refresh token on seeing it.
 */
import getPrisma from "@/lib/db"
import { mintOAuthToken } from "@/lib/oauth/tokens"

/**
 * One hour. Short enough that a leaked access token has a bounded life, long
 * enough that a typical MCP session never refreshes mid-conversation. Refresh
 * is cheap and automatic for every client Compass targets, so there is no
 * reason to stretch it.
 */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
/** 30 days of inactivity before a client must send the user back through consent. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The RFC 6749 §5.1 token response body. */
export interface TokenResponseBody {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  refresh_token: string
  scope: string
}

export interface IssueTokenPairInput {
  clientId: string
  userId: string
  scope: string
  resource: string
  /** The founding authorization code's row id. See the module doc. */
  familyId: string
  /** The refresh token this pair replaces, when rotating. */
  parentTokenId?: string | null
  /** Null = every workspace the user belongs to (decision 1). */
  scopeWorkspaceId?: string | null
}

export async function issueTokenPair(
  input: IssueTokenPairInput,
  now: Date = new Date(),
): Promise<TokenResponseBody> {
  const prisma = getPrisma()
  const access = mintOAuthToken("ACCESS")
  const refresh = mintOAuthToken("REFRESH")

  const common = {
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    resource: input.resource,
    familyId: input.familyId,
    parentTokenId: input.parentTokenId ?? null,
    scopeWorkspaceId: input.scopeWorkspaceId ?? null,
  }

  // Two rows, not a transaction. DSQL has no foreign keys and these two inserts
  // touch different rows, so a transaction would buy only atomicity of the
  // *pair* — and the failure it would guard against (access written, refresh
  // not) degrades to the client holding a working access token with no way to
  // refresh, which is exactly what it would get from a rolled-back transaction
  // anyway, minus an hour of usable session.
  await prisma.oAuthToken.create({
    data: {
      ...common,
      tokenHash: access.tokenHash,
      type: "ACCESS",
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    },
  })
  await prisma.oAuthToken.create({
    data: {
      ...common,
      tokenHash: refresh.tokenHash,
      type: "REFRESH",
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  })

  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh.token,
    scope: input.scope,
  }
}

/**
 * Revokes every unrevoked token in a family.
 *
 * Idempotent by construction (`revokedAt: null` in the predicate), so calling
 * it twice on a replay storm is harmless.
 */
export async function revokeTokenFamily(familyId: string, now: Date = new Date()): Promise<number> {
  const { count } = await getPrisma().oAuthToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  })
  return count
}

/** The stored refresh token, as far as rotation cares. */
export interface RefreshTokenRow {
  id: string
  clientId: string
  userId: string
  scope: string
  resource: string
  scopeWorkspaceId: string | null
  familyId: string
  expiresAt: Date
  revokedAt: Date | null
}

export type RefreshClaim =
  | { ok: true; token: RefreshTokenRow }
  | { ok: false; reason: "unknown" | "expired" }
  /**
   * The presented token was already revoked, or a concurrent request rotated it
   * first. Both mean the same thing on the wire and both revoke the family: a
   * refresh token is single-use, so a second presentation is by definition
   * either a replay or a client bug that is indistinguishable from one.
   */
  | { ok: false; reason: "reused"; familyId: string }

/**
 * Atomically rotates a refresh token out of service and returns the row it
 * replaced.
 *
 * Same conditional-update discipline as {@link import("./codes").claimAuthorizationCode}:
 * the `revokedAt: null` predicate is the gate, and a zero affected count means
 * someone else got there first.
 */
export async function claimRefreshToken(
  tokenHash: string,
  now: Date = new Date(),
): Promise<RefreshClaim> {
  const prisma = getPrisma()
  const existing = await prisma.oAuthToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      type: true,
      clientId: true,
      userId: true,
      scope: true,
      resource: true,
      scopeWorkspaceId: true,
      familyId: true,
      expiresAt: true,
      revokedAt: true,
    },
  })
  if (!existing || existing.type !== "REFRESH") return { ok: false, reason: "unknown" }

  // Reuse detection, before anything else: a token that is already revoked is
  // being replayed, and the family goes regardless of whether it had also
  // expired.
  if (existing.revokedAt) {
    await revokeTokenFamily(existing.familyId, now)
    return { ok: false, reason: "reused", familyId: existing.familyId }
  }
  if (existing.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" }

  let claimed: { count: number }
  try {
    claimed = await prisma.oAuthToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    })
  } catch {
    // DSQL OCC abort — a concurrent rotation of the same token.
    await revokeTokenFamily(existing.familyId, now)
    return { ok: false, reason: "reused", familyId: existing.familyId }
  }
  if (claimed.count === 0) {
    await revokeTokenFamily(existing.familyId, now)
    return { ok: false, reason: "reused", familyId: existing.familyId }
  }

  // Rebuilt field by field rather than spread-minus-`type`, so the returned
  // shape is exactly RefreshTokenRow and adding a column to the select above
  // cannot silently widen what callers receive.
  return {
    ok: true,
    token: {
      id: existing.id,
      clientId: existing.clientId,
      userId: existing.userId,
      scope: existing.scope,
      resource: existing.resource,
      scopeWorkspaceId: existing.scopeWorkspaceId,
      familyId: existing.familyId,
      expiresAt: existing.expiresAt,
      revokedAt: existing.revokedAt,
    },
  }
}

export type RevocationTarget =
  | { found: true; type: "ACCESS" | "REFRESH"; clientId: string; familyId: string; id: string }
  | { found: false }

export async function findRevocationTarget(tokenHash: string): Promise<RevocationTarget> {
  const row = await getPrisma().oAuthToken.findUnique({
    where: { tokenHash },
    select: { id: true, type: true, clientId: true, familyId: true },
  })
  if (!row || (row.type !== "ACCESS" && row.type !== "REFRESH")) return { found: false }
  return { found: true, id: row.id, type: row.type, clientId: row.clientId, familyId: row.familyId }
}

/** Revokes a single token by row id. Used for access-token revocation. */
export async function revokeTokenById(id: string, now: Date = new Date()): Promise<void> {
  await getPrisma().oAuthToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now } })
}
