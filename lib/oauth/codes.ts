/**
 * Authorization codes: issue, and claim exactly once.
 *
 * ## The claim is the whole point of this module
 *
 * A code is a bearer credential that converts into a token, so "consumed
 * exactly once" is the single property everything else rests on. The
 * implementation is a **conditional update**, never a read-then-write:
 *
 * ```sql
 * UPDATE oauth_authorization_codes SET consumed_at = now()
 *  WHERE code_hash = $1 AND consumed_at IS NULL
 * ```
 *
 * and the affected count is the answer. `SELECT` then `UPDATE` would leave a
 * window in which two concurrent exchanges both read `consumed_at IS NULL` and
 * both mint a token pair — a double-spend that no downstream check can detect,
 * because both tokens are individually valid.
 *
 * On Aurora DSQL there is a second way the race resolves. DSQL uses optimistic
 * concurrency control, so two transactions writing the same row do not
 * serialise — the loser aborts with `OC001`. {@link claimAuthorizationCode}
 * therefore treats a write conflict as a *lost claim*, exactly like a zero
 * affected count, rather than letting it escape as a 500.
 *
 * ## Claim first, validate after
 *
 * The claim runs *before* PKCE, redirect-URI and expiry checks, so a failed
 * exchange still burns the code. That is intentional: a code is single-use,
 * and letting a wrong `code_verifier` leave it spendable turns it into an
 * oracle an attacker can retry against.
 */
import getPrisma from "@/lib/db"
import { hashOAuthToken, mintAuthorizationCode } from "@/lib/oauth/tokens"

/** 60 s, per the design. Long enough for a browser redirect, short enough that
 *  an intercepted code is close to worthless. */
export const AUTHORIZATION_CODE_TTL_MS = 60_000

export interface IssuedAuthorizationCode {
  code: string
  expiresAt: Date
}

/**
 * Which identity the tokens issued from this grant will act as (ADR 0015).
 * `"AGENT"` requires `agentId`; `"USER"` is the admin override and today's
 * legacy behavior. Stored as a distinct value from `agentId` so that a null
 * agent is never ambiguous between "override elected" and "predates binding".
 */
export type AuthorizationMode = "AGENT" | "USER"

export interface AuthorizationBinding {
  /** Omitted means USER mode, matching the column default. */
  authorizationMode?: AuthorizationMode
  agentId?: string | null
}

/**
 * Normalises a stored binding for carrying forward into a freshly minted row —
 * code to token, and token to rotated token.
 *
 * The same **closed two-way switch** `validateOAuthAccessToken` applies: a
 * stored mode that is not exactly `"AGENT"` carries no agent forward, so a
 * stray `agent_id` left on a USER-mode row can never become live by being
 * copied into a new token.
 *
 * `"AGENT"` with a missing `agentId` is carried forward **as-is** rather than
 * quietly repaired to USER. That state is unwritable today, but if it ever
 * occurred, "repairing" it would hand the client a broader token than the one
 * it presented. Carried forward it stays narrower than broken:
 * `validateOAuthAccessToken` refuses an AGENT-mode token with no agent, so the
 * client gets a 401 and re-consents.
 */
export function carryAuthorizationBinding(row: {
  authorizationMode: string | null
  agentId: string | null
}): Required<AuthorizationBinding> {
  return row.authorizationMode === "AGENT"
    ? { authorizationMode: "AGENT", agentId: row.agentId }
    : { authorizationMode: "USER", agentId: null }
}

export interface AuthorizationCodeInput extends AuthorizationBinding {
  clientId: string
  userId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope: string
  resource: string
}

export async function issueAuthorizationCode(
  input: AuthorizationCodeInput,
  now: Date = new Date(),
): Promise<IssuedAuthorizationCode> {
  const { code, codeHash } = mintAuthorizationCode()
  const expiresAt = new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS)
  // Written out field by field, never `{ ...input }`. Both call sites pass a
  // whole `PendingAuthorizationRequest`, which also carries `state` — a client
  // value that belongs in the redirect, not in a column. A spread hands that
  // straight to Prisma, TypeScript's excess-property check does not fire
  // through a spread, and the result is a runtime `Unknown argument "state"`
  // that only appears once a real authorization is attempted. Same discipline
  // as `claimRefreshToken` in lib/oauth/grants.ts, for the same reason.
  await getPrisma().oAuthAuthorizationCode.create({
    data: {
      codeHash,
      expiresAt,
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod,
      scope: input.scope,
      resource: input.resource,
      // Omitted by every caller that has no binding to express, which lets
      // Prisma's @default("USER") stand rather than writing an explicit null.
      authorizationMode: input.authorizationMode,
      agentId: input.agentId ?? null,
    },
  })
  return { code, expiresAt }
}

/** The row behind a successfully claimed code. */
export interface ClaimedAuthorizationCode {
  id: string
  clientId: string
  userId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope: string
  resource: string
  /** Null only on a row written before migration 056; read as USER mode. */
  authorizationMode: string | null
  agentId: string | null
  expiresAt: Date
}

export type AuthorizationCodeClaim =
  | { ok: true; code: ClaimedAuthorizationCode }
  /** No such code, or it was never ours. Nothing to revoke. */
  | { ok: false; reason: "unknown" }
  /**
   * The code existed and had already been consumed. OAuth 2.1 §4.1.3 says the
   * authorization server SHOULD revoke the tokens previously issued from it,
   * and `familyId` carries exactly that link — see {@link ClaimedAuthorizationCode}.
   */
  | { ok: false; reason: "replayed"; familyId: string }
  /** A concurrent exchange won the claim. Indistinguishable from a replay from
   *  the loser's point of view, and treated the same on the wire. */
  | { ok: false; reason: "conflict" }

const CLAIMED_FIELDS = {
  id: true,
  clientId: true,
  userId: true,
  redirectUri: true,
  codeChallenge: true,
  codeChallengeMethod: true,
  scope: true,
  resource: true,
  authorizationMode: true,
  agentId: true,
  expiresAt: true,
} as const

export async function claimAuthorizationCode(
  code: string,
  now: Date = new Date(),
): Promise<AuthorizationCodeClaim> {
  const prisma = getPrisma()
  const codeHash = hashOAuthToken(code)

  let claimed: { count: number }
  try {
    claimed = await prisma.oAuthAuthorizationCode.updateMany({
      where: { codeHash, consumedAt: null },
      data: { consumedAt: now },
    })
  } catch {
    // A DSQL OCC abort. The other writer got the code; this caller did not.
    return { ok: false, reason: "conflict" }
  }

  if (claimed.count === 0) {
    const existing = await prisma.oAuthAuthorizationCode.findUnique({
      where: { codeHash },
      select: { id: true },
    })
    // The family is founded by the code that started it — see lib/oauth/grants.ts.
    return existing ? { ok: false, reason: "replayed", familyId: existing.id } : { ok: false, reason: "unknown" }
  }

  const row = await prisma.oAuthAuthorizationCode.findUnique({
    where: { codeHash },
    select: CLAIMED_FIELDS,
  })
  // Only reachable if the row vanished between the update and the read, which
  // means someone deleted it mid-exchange. Fail closed.
  if (!row) return { ok: false, reason: "unknown" }
  return { ok: true, code: row }
}
