/**
 * The consent step: CSRF-proofing the approval, remembering an approval, and
 * enumerating what is actually being granted.
 *
 * ## The form carries a signed request, not fields
 *
 * The consent form has exactly one input: an opaque HMAC-signed blob produced
 * by {@link signAuthorizationRequest}, holding the whole validated authorization
 * request. The POST handler decodes the request *out of the signature* rather
 * than reading hidden form fields.
 *
 * That collapses two problems into one mechanism:
 *
 *  - **CSRF.** The blob is bound to `session.user.id`, so a form a different
 *    site tricks the user into submitting carries either no blob or one signed
 *    for someone else, and verification fails. No third-party site can mint one.
 *  - **Parameter tampering.** There are no unsigned fields for an attacker to
 *    rewrite between the screen the user read and the code that gets issued. A
 *    consent screen that says "127.0.0.1" and a POST that swaps in
 *    `evil.com` is the classic version of this bug; here the redirect URI is
 *    inside the signature.
 *
 * ## The `__Host-` cookie is set *after* approval, never before
 *
 * `GET /oauth/authorize` writes no cookies at all. An anonymous or
 * not-yet-approved visit leaves no state behind, so a drive-by GET — from an
 * `<img>` tag, a prefetch, a link in an email — cannot plant anything that a
 * later request would honour. The cookie appears only on the POST that follows
 * a human clicking Allow.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import getPrisma from "@/lib/db"

/**
 * `__Host-` is the strongest cookie prefix: the browser enforces `Secure`,
 * `Path=/`, and no `Domain` attribute, which means a sibling subdomain cannot
 * set or overwrite it. That matters because this cookie is an approval record —
 * a subdomain takeover that could write it would be able to skip the consent
 * screen.
 */
export const CONSENT_COOKIE_NAME = "__Host-compass_oauth_consent"
/** 90 days. Re-consent is one click for a signed-in user. */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60
/** How long a rendered consent screen stays submittable. */
export const CONSENT_REQUEST_TTL_MS = 10 * 60 * 1000
/** Bounds the cookie so it cannot grow without limit across many installs. */
const MAX_REMEMBERED_CLIENTS = 20

export const CONSENT_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: CONSENT_COOKIE_MAX_AGE_SECONDS,
} as const

/**
 * The key for every HMAC in this module.
 *
 * `AUTH_SECRET` is already the deployment's session-signing secret, so reusing
 * it means there is no *second* secret to rotate, store, or forget — and a
 * deployment that can mint sessions can already mint anything this key protects.
 * `OAUTH_CONSENT_SECRET` exists as an override for anyone who wants them
 * separated.
 *
 * Outside production a fixed development key is used rather than throwing:
 * `auth.ts`'s dev path uses the Credentials provider and local setups do not set
 * `AUTH_SECRET`, so failing closed here would make the consent screen
 * untestable locally. The value is a constant and is worthless anywhere real.
 */
export function consentSigningKey(): string {
  const configured = process.env.OAUTH_CONSENT_SECRET || process.env.AUTH_SECRET
  if (configured) return configured
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET (or OAUTH_CONSENT_SECRET) is required to sign OAuth consent.")
  }
  return "compass-development-only-oauth-consent-key"
}

/** The authorization request, after the authorize endpoint has validated it. */
export interface PendingAuthorizationRequest {
  clientId: string
  /** The value the client asked for, already matched against a registered URI. */
  redirectUri: string
  state: string | null
  codeChallenge: string
  codeChallengeMethod: string
  scope: string
  resource: string
}

interface SignedPayload extends PendingAuthorizationRequest {
  /** Binds the blob to one signed-in user. This is the CSRF property. */
  u: string
  /** Expiry, epoch milliseconds. */
  x: number
}

export function signAuthorizationRequest(
  request: PendingAuthorizationRequest,
  userId: string,
  now: Date = new Date(),
): string {
  const payload: SignedPayload = { ...request, u: userId, x: now.getTime() + CONSENT_REQUEST_TTL_MS }
  return sign(payload)
}

/**
 * Recovers the request from a signed blob, or `null`.
 *
 * Returns `null` for every failure mode — bad shape, bad signature, wrong user,
 * expired — without distinguishing them to the caller. There is no legitimate
 * client behaviour that tells these apart, and the endpoint's response is the
 * same either way.
 */
export function verifyAuthorizationRequest(
  blob: string | null | undefined,
  userId: string,
  now: Date = new Date(),
): PendingAuthorizationRequest | null {
  const payload = verify<SignedPayload>(blob)
  if (!payload) return null
  if (typeof payload.u !== "string" || payload.u !== userId) return null
  if (typeof payload.x !== "number" || payload.x <= now.getTime()) return null
  if (typeof payload.clientId !== "string" || typeof payload.redirectUri !== "string") return null
  if (typeof payload.codeChallenge !== "string" || typeof payload.scope !== "string") return null
  if (typeof payload.resource !== "string") return null
  return {
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    state: typeof payload.state === "string" ? payload.state : null,
    codeChallenge: payload.codeChallenge,
    codeChallengeMethod: payload.codeChallengeMethod,
    scope: payload.scope,
    resource: payload.resource,
  }
}

interface ConsentCookiePayload {
  /** Owning user. A cookie that survives a user switch must not be honoured. */
  u: string
  /** Approved `client_id`s, each paired with the scope that was approved. */
  c: Array<[clientId: string, scope: string]>
  x: number
}

/**
 * Builds the next cookie value, folding one newly approved client into whatever
 * the browser already had.
 *
 * The scope is stored alongside the client id so a *widened* request does not
 * silently reuse an older, narrower approval — {@link consentCookieApproves}
 * requires the recorded scope to cover the requested one.
 */
export function buildConsentCookie(
  existing: string | null | undefined,
  userId: string,
  clientId: string,
  scope: string,
  now: Date = new Date(),
): string {
  const previous = readConsentCookie(existing, userId, now)
  const others = previous.filter(([id]) => id !== clientId)
  const entries: ConsentCookiePayload["c"] = [
    [clientId, scope] as [string, string],
    ...others,
  ].slice(0, MAX_REMEMBERED_CLIENTS)
  const payload: ConsentCookiePayload = {
    u: userId,
    c: entries,
    x: now.getTime() + CONSENT_COOKIE_MAX_AGE_SECONDS * 1000,
  }
  return sign(payload)
}

/** The approved `[clientId, scope]` pairs in a cookie, or `[]`. */
export function readConsentCookie(
  raw: string | null | undefined,
  userId: string,
  now: Date = new Date(),
): ConsentCookiePayload["c"] {
  const payload = verify<ConsentCookiePayload>(raw)
  if (!payload || payload.u !== userId) return []
  if (typeof payload.x !== "number" || payload.x <= now.getTime()) return []
  if (!Array.isArray(payload.c)) return []
  return payload.c.filter(
    (entry): entry is [string, string] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "string",
  )
}

/** Does the cookie record an approval of `clientId` covering every requested scope? */
export function consentCookieApproves(
  raw: string | null | undefined,
  userId: string,
  clientId: string,
  requestedScopes: readonly string[],
  now: Date = new Date(),
): boolean {
  const entry = readConsentCookie(raw, userId, now).find(([id]) => id === clientId)
  if (!entry) return false
  return scopeCovers(entry[1], requestedScopes)
}

/** True when `granted` (a space-delimited scope string) contains every requested scope. */
export function scopeCovers(granted: string, requested: readonly string[]): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean))
  return requested.every((scope) => have.has(scope))
}

/**
 * The durable half of "remember this approval".
 *
 * `OAuthConsent` is unique on `(userId, clientId)`, so re-approving with a
 * different scope overwrites rather than accumulating rows — the latest
 * approval is the only one that means anything.
 */
export async function recordConsent(
  userId: string,
  clientId: string,
  scope: string,
): Promise<void> {
  await getPrisma().oAuthConsent.upsert({
    where: { userId_clientId: { userId, clientId } },
    create: { userId, clientId, scope, grantedAt: new Date() },
    update: { scope, grantedAt: new Date() },
  })
}

/** Has this user already approved this client for at least these scopes? */
export async function hasStoredConsent(
  userId: string,
  clientId: string,
  requestedScopes: readonly string[],
): Promise<boolean> {
  const row = await getPrisma().oAuthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { scope: true },
  })
  return row ? scopeCovers(row.scope, requestedScopes) : false
}

/** One organization and the workspaces inside it the token would reach. */
export interface GrantedOrganization {
  id: string
  name: string
  slug: string
  /** True when the user is an organization member, not only a workspace member. */
  organizationMember: boolean
  workspaces: Array<{ id: string; name: string; slug: string }>
}

/**
 * Everything an issued token would be able to reach, for the consent screen.
 *
 * Per decision 1 there is no workspace picker: an OAuth token carries the same
 * reach a per-user `cmp_…` API key already has — every workspace the user is a
 * member of, across every organization. Enumerating it is the compensating
 * control that decision was made in exchange for, because "connect Compass"
 * sounds like one workspace and is in fact all of them.
 *
 * The reach mirrors `agentWorkspaceWhere` in lib/agent-access.ts, which is what
 * actually gates a `purpose: "USER"` actor: membership in `WorkspaceMember`.
 * Organizations the user belongs to but has no workspace membership in are
 * listed too — org-level MCP tools resolve against `OrganizationMember`, so
 * omitting them would understate the grant.
 */
export async function grantedOrganizations(userId: string): Promise<GrantedOrganization[]> {
  const prisma = getPrisma()
  const [workspaceMemberships, orgMemberships] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      select: {
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    }),
    prisma.organizationMember.findMany({
      where: { userId },
      select: { organization: { select: { id: true, name: true, slug: true } } },
    }),
  ])

  const byOrg = new Map<string, GrantedOrganization>()
  const ensure = (org: { id: string; name: string; slug: string }): GrantedOrganization => {
    const found = byOrg.get(org.id)
    if (found) return found
    const created: GrantedOrganization = { ...org, organizationMember: false, workspaces: [] }
    byOrg.set(org.id, created)
    return created
  }

  for (const { organization } of orgMemberships) ensure(organization).organizationMember = true
  for (const { workspace } of workspaceMemberships) {
    ensure(workspace.organization).workspaces.push({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    })
  }

  const collator = new Intl.Collator("en")
  const organizations = [...byOrg.values()]
  for (const org of organizations) org.workspaces.sort((a, b) => collator.compare(a.name, b.name))
  organizations.sort((a, b) => collator.compare(a.name, b.name))
  return organizations
}

// ── signing primitives ────────────────────────────────────────────────────

function sign(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `${body}.${hmac(body)}`
}

function verify<T>(token: string | null | undefined): T | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) return null
  const separator = token.lastIndexOf(".")
  if (separator <= 0) return null
  const body = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!constantTimeEquals(hmac(body), signature)) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

function hmac(body: string): string {
  return createHmac("sha256", consentSigningKey()).update(body).digest("base64url")
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  // Both sides are fixed-length base64url HMACs, so the length check leaks
  // nothing beyond what the format already announces.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
