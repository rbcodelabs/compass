/**
 * The consent step: CSRF-proofing the approval, remembering an approval, and
 * enumerating what is actually being granted.
 *
 * ## The request is signed; the binding choice is re-validated
 *
 * The consent form carries an opaque HMAC-signed blob produced by
 * {@link signAuthorizationRequest}, holding the whole validated authorization
 * request. The POST handler recovers the client, redirect URI, scope, PKCE
 * challenge, audience and state *from that signature*, never from unsigned
 * copies.
 *
 * ADR 0015 also adds unsigned fields for the choice the user makes on this
 * screen: binding mode, existing/new agent details, selected workspace grants
 * and the typed full-account confirmation. The GET that signed the request
 * could not have known that later choice. The POST therefore treats those
 * fields as untrusted input and independently re-validates each one against
 * the signed-in user before it records consent or issues a code.
 *
 * Together those mechanisms cover two different boundaries:
 *
 *  - **CSRF.** The blob is bound to `session.user.id`, so a form a different
 *    site tricks the user into submitting carries either no blob or one signed
 *    for someone else, and verification fails. No third-party site can mint one.
 *  - **Request parameter tampering.** A consent screen that says `127.0.0.1`
 *    and a POST that swaps in `evil.com` is the canonical attack; here the
 *    redirect URI and every other client-controlled authorization parameter
 *    are inside the signature.
 *  - **Binding field tampering.** The unsigned fields can name only an agent
 *    the user owns, workspaces they may administer, or the full-account
 *    override when its live predicate and typed confirmation both hold. A
 *    hand-written form cannot turn those fields into authority the session
 *    user was not independently entitled to choose.
 *
 * ## There is no consent cookie, deliberately (ADR 0015)
 *
 * Phase 1 remembered an approval two ways: an `OAuthConsent` row and a
 * 90-day, HMAC-signed `__Host-` cookie, ORed together at
 * `app/oauth/authorize/page.tsx`. **The cookie is gone.** Once the remembered
 * approval carries an *authorization binding* — which identity the connection
 * acts as — it became a security-relevant decision, and a security-relevant
 * decision may not live in client state that no server-side migration can
 * reach. Deleting every `OAuthConsent` row would have left the cookie happily
 * short-circuiting the new screen on the very browser that authorized the
 * over-privileged connection, for ninety days.
 *
 * What is lost is one indexed primary-key read per reconnect. What is gained is
 * a single source of truth for remembered consent that is durable, inspectable,
 * and revocable server-side. That trade is not close.
 *
 * `GET /oauth/authorize` continues to write nothing at all — no cookie, no row.
 * A drive-by GET from an `<img>` tag, a prefetch or a link in an email leaves
 * no state behind that a later request could honour as consent.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import getPrisma, { type AppPrismaClient, type AppTransactionClient } from "@/lib/db"
import type { AuthorizationBinding } from "@/lib/oauth/codes"

/** How long a rendered consent screen stays submittable. */
export const CONSENT_REQUEST_TTL_MS = 10 * 60 * 1000

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

/** True when `granted` (a space-delimited scope string) contains every requested scope. */
export function scopeCovers(granted: string, requested: readonly string[]): boolean {
  const have = new Set(granted.split(/\s+/).filter(Boolean))
  return requested.every((scope) => have.has(scope))
}

/**
 * The *only* record of "remember this approval", now that the cookie is gone.
 *
 * `OAuthConsent` is unique on `(userId, clientId)`, so re-approving with a
 * different scope or a different binding overwrites rather than accumulating
 * rows — the latest approval is the only one that means anything. The binding
 * is data on that row rather than part of its identity, which is what makes a
 * returning client replay the binding it was given instead of being silently
 * offered a second, parallel one.
 */
export async function recordConsent(
  userId: string,
  clientId: string,
  scope: string,
  binding: Required<AuthorizationBinding> = { authorizationMode: "USER", agentId: null },
  prisma: Pick<AppPrismaClient | AppTransactionClient, "oAuthConsent"> = getPrisma(),
): Promise<void> {
  const data = {
    scope,
    grantedAt: new Date(),
    authorizationMode: binding.authorizationMode,
    agentId: binding.agentId,
  }
  await prisma.oAuthConsent.upsert({
    where: { userId_clientId: { userId, clientId } },
    create: { userId, clientId, ...data },
    update: data,
  })
}

/** A remembered approval, with the binding it was given. */
export interface StoredConsent {
  /** Null only on a malformed or incompletely migrated row; reject it. */
  authorizationMode: string | null
  agentId: string | null
}

/**
 * The remembered approval covering every requested scope, or `null`.
 *
 * Returns the row rather than a boolean because the caller has to replay the
 * *binding*, not merely skip the screen. A widened request still returns
 * `null`: an older, narrower approval must not cover a request for more.
 */
export async function findStoredConsent(
  userId: string,
  clientId: string,
  requestedScopes: readonly string[],
  prisma: Pick<AppPrismaClient | AppTransactionClient, "oAuthConsent"> = getPrisma(),
): Promise<StoredConsent | null> {
  const row = await prisma.oAuthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { scope: true, authorizationMode: true, agentId: true },
  })
  if (!row || !scopeCovers(row.scope, requestedScopes)) return null
  return { authorizationMode: row.authorizationMode, agentId: row.agentId }
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

/** The enumeration the consent screen renders, plus what it could not resolve. */
export interface GrantedAccessSummary {
  organizations: GrantedOrganization[]
  /**
   * Membership rows that name a workspace or organization which no longer
   * exists. Counted rather than dropped on the floor — see {@link grantedAccess}.
   */
  unresolvedMemberships: number
}

/**
 * The shapes the `select`s below *actually* return.
 *
 * Prisma types both relations as non-nullable because the schema declares them
 * required — but `relationMode = "prisma"` means the database enforces no
 * foreign keys and performs no cascade deletes, so an ordinary workspace or
 * organization deletion leaves the membership row behind pointing at nothing.
 * The relation then resolves to `null` at runtime while the generated type
 * still insists it cannot. These aliases make that gap explicit instead of
 * letting an unguarded dereference inherit a false guarantee.
 */
interface ResolvedOrganization {
  id: string
  name: string
  slug: string
}
interface ResolvedWorkspace {
  id: string
  name: string
  slug: string
  organization: ResolvedOrganization | null
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
 *
 * ## Why an unresolvable membership is counted, not silently skipped
 *
 * A membership row whose workspace or organization has been deleted must not
 * take the screen down — a user who cannot render the consent screen cannot
 * authorize at all, which is a total outage of this endpoint triggered by an
 * ordinary workspace deletion. So such rows are skipped.
 *
 * But skipping *silently* would quietly under-report a grant on the one screen
 * whose entire job is to state the grant accurately, and this enumeration is
 * the compensating control for there being no workspace picker. So the count
 * comes back with the list and the screen says a row could not be shown.
 *
 * Under-reporting here is bounded rather than merely disclosed: `agentWorkspaceWhere`
 * resolves access by querying `Workspace` with `members: { some: { userId } }`,
 * so a membership pointing at a deleted workspace matches no row and confers no
 * access. What is omitted is a dangling pointer, not reachable data — the
 * disclosure exists so the user is told the list is imperfect, not because
 * access is being hidden.
 */
export async function grantedAccess(userId: string): Promise<GrantedAccessSummary> {
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
  let unresolvedMemberships = 0
  const ensure = (org: ResolvedOrganization): GrantedOrganization => {
    const found = byOrg.get(org.id)
    if (found) return found
    const created: GrantedOrganization = { ...org, organizationMember: false, workspaces: [] }
    byOrg.set(org.id, created)
    return created
  }

  for (const { organization } of orgMemberships as Array<{
    organization: ResolvedOrganization | null
  }>) {
    if (!organization) {
      unresolvedMemberships += 1
      continue
    }
    ensure(organization).organizationMember = true
  }

  for (const { workspace } of workspaceMemberships as Array<{
    workspace: ResolvedWorkspace | null
  }>) {
    if (!workspace || !workspace.organization) {
      unresolvedMemberships += 1
      continue
    }
    ensure(workspace.organization).workspaces.push({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    })
  }

  if (unresolvedMemberships > 0) {
    // A data-integrity defect, not a user error: something deleted a workspace
    // or organization without clearing its membership rows. Surfaced in the
    // logs so it can be repaired, having already been handled on screen.
    console.warn(
      `[oauth/consent] ${unresolvedMemberships} membership row(s) for user ${userId} reference a deleted workspace or organization`,
    )
  }

  const collator = new Intl.Collator("en")
  const organizations = [...byOrg.values()]
  for (const org of organizations) org.workspaces.sort((a, b) => collator.compare(a.name, b.name))
  organizations.sort((a, b) => collator.compare(a.name, b.name))
  return { organizations, unresolvedMemberships }
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
