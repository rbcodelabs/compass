/**
 * `GET /oauth/authorize` — the authorization endpoint and its consent screen.
 *
 * ## Why this is a page and not in `isPublicPath`
 *
 * `/oauth/authorize` is deliberately **absent** from `isPublicPath`, so an
 * anonymous visitor hits the middleware auth redirect in `proxy.ts` and is sent
 * to `/login?callbackUrl=<this URL, query string intact>`. That is the whole
 * reason the return-URL preservation was fixed first: an authorize request is
 * *entirely* query string — `client_id`, `redirect_uri`, `state`,
 * `code_challenge`, `scope`, `resource` — and MCP clients open a fresh browser,
 * so the not-signed-in case is the common one, not the edge case.
 *
 * Because of that, `auth()` returning nothing here should be unreachable. It is
 * still handled, because "unreachable" is a claim about the middleware, and an
 * authorization endpoint that issues a code without knowing who the user is
 * would be the worst possible bug in this system.
 *
 * ## What the consent screen has to say, and why
 *
 * Three things, all of them consequences of decisions recorded in the design:
 *
 *  - **The organizations and workspaces being granted, by name.** Decision 1
 *    removed the workspace picker: the token carries the same reach a per-user
 *    `cmp_…` API key already has, meaning *every* workspace the user belongs to
 *    across *every* organization. "Connect Compass" reads like one workspace and
 *    is in fact all of them, so the enumeration is the compensating control that
 *    decision was made in exchange for.
 *  - **The redirect host, prominently.** Registration is open (decision 2) and
 *    there are no verified clients (decision 4), so `client_name` is
 *    attacker-chosen — anyone can register "Compass Official". The redirect host
 *    is the one field on this screen that cannot be forged, because it is where
 *    the authorization code will actually be delivered.
 *  - **An explicit unverified marker.** Not on *some* clients: on every one of
 *    them. A badge that appears only sometimes trains people to read its absence
 *    as an endorsement, and here there is nothing to endorse.
 */
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { auth } from "@/auth"
import { Button } from "@/components/ui/button"
import { CompassUrlNotConfiguredError } from "@/lib/compass-url"
import {
  buildAuthorizationErrorUrl,
  buildAuthorizationSuccessUrl,
  validateAuthorizationRequest,
} from "@/lib/oauth/authorize-request"
import { issueAuthorizationCode } from "@/lib/oauth/codes"
import {
  CONSENT_COOKIE_NAME,
  consentCookieApproves,
  grantedAccess,
  hasStoredConsent,
  signAuthorizationRequest,
  type GrantedAccessSummary,
} from "@/lib/oauth/consent"
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE, SCOPE_OFFLINE_ACCESS, parseScope } from "@/lib/oauth/constants"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Authorize application",
  // An authorization screen must never be indexed, and its URL carries the
  // client's `state` and `code_challenge`.
  robots: { index: false, follow: false },
}

interface AuthorizePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AuthorizePage({ searchParams }: AuthorizePageProps) {
  const raw = await searchParams
  const params = toSearchParams(raw)

  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    // Defence in depth behind proxy.ts. Rebuilt from the parsed parameters
    // rather than echoed, so nothing unparsed round-trips into a Location header.
    redirect(`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`)
  }

  let validated: Awaited<ReturnType<typeof validateAuthorizationRequest>>
  try {
    validated = await validateAuthorizationRequest(params)
  } catch (error) {
    // The deployment cannot resolve its own origin, so it cannot name the
    // audience it would mint for. A 404-shaped "no OAuth here" would be a lie;
    // this says the server is broken, without naming the missing variable.
    if (error instanceof CompassUrlNotConfiguredError) {
      return <FatalError title="Authorization is unavailable" detail="This deployment is not configured to issue OAuth tokens." />
    }
    throw error
  }

  if (!validated.ok) {
    if (validated.kind === "fatal") {
      // No verified redirect_uri exists, so there is nowhere safe to send the
      // user. Telling them directly is what OAuth 2.1 §4.1.2.1 requires.
      return <FatalError title="This application cannot be authorized" detail={validated.description} />
    }
    redirect(buildAuthorizationErrorUrl(validated))
  }

  const { request, client } = validated
  const requestedScopes = parseScope(request.scope)

  // Two independent records of a previous approval. The database row is
  // durable and survives a new browser; the cookie makes the common
  // same-browser reconnect free even if the row was cleared. Either is enough.
  const cookieStore = await cookies()
  const remembered =
    consentCookieApproves(
      cookieStore.get(CONSENT_COOKIE_NAME)?.value,
      userId,
      request.clientId,
      requestedScopes,
    ) || (await hasStoredConsent(userId, request.clientId, requestedScopes))

  if (remembered) {
    const { code } = await issueAuthorizationCode({ ...request, userId })
    redirect(
      buildAuthorizationSuccessUrl({ redirectUri: request.redirectUri, code, state: request.state }),
    )
  }

  const granted = await grantedAccess(userId)
  const signedRequest = signAuthorizationRequest(request, userId)
  const redirectHost = new URL(request.redirectUri).host || request.redirectUri

  /*
    ## Why the card owns the viewport instead of the document

    Approve and Deny are the only two controls on this screen, and at 1280×800
    the enumeration above them is tall enough to push "Allow access" past the
    fold — measured at 807px against an 800px viewport, so the primary action
    was clipped by 7px at the standard desktop size, and sat 59px below the fold
    at 390×844. A consent control the user has to go looking for is a consent
    control they can approve without having read what is above it.

    None of the content can go: the client name, the redirect host, the scope
    list, the org/workspace enumeration and the unverified marking are each a
    named compensating control in the design's security section. So the *page*
    stops scrolling and the *content* scrolls instead — `main` is pinned to the
    viewport, the descriptive region scrolls inside the card, and the action row
    is a sibling of that region rather than the last thing inside it. That makes
    both buttons unconditionally visible at any viewport height, and the divider
    above them reads as the boundary it now is.
  */
  return (
    <main className="flex h-dvh items-center justify-center overflow-hidden bg-surface-app px-4 py-6">
      <div className="flex max-h-full w-full max-w-lg flex-col gap-3">
        <div className="flex min-h-0 flex-col rounded-2xl border border-border-default bg-surface-panel shadow-[var(--shadow-card)]">
          {/*
            `tabIndex` is load-bearing, not decoration. Moving the buttons out
            of this region left it with no focusable descendant, and a
            scrollable region containing nothing focusable cannot be scrolled by
            keyboard at all (WCAG 2.1.1). On this screen that would mean a
            keyboard-only user could reach "Allow access" while being physically
            unable to read the grant it approves. Making the region itself a tab
            stop restores arrow-key and Page Down scrolling, and the label tells
            a screen-reader user what they have landed in.
          */}
          <div
            role="region"
            aria-label="Authorization details"
            tabIndex={0}
            className="min-h-0 space-y-4 overflow-y-auto p-6 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:p-7"
          >
            <div className="space-y-1">
              <h1 className="text-lg font-bold text-text-primary">
                Authorize {client.clientName}
              </h1>
              <p className="text-sm text-text-subtle">
                {client.clientName} is asking to connect to Compass as{" "}
                <span className="font-medium text-text-primary">
                  {session?.user?.email ?? "your account"}
                </span>
                .
              </p>
            </div>

            <UnverifiedNotice redirectHost={redirectHost} redirectUri={request.redirectUri} />

            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
                What it will be able to do
              </h2>
              <ul className="space-y-1.5 text-sm text-text-primary">
                {requestedScopes.map((scope) => (
                  <li key={scope} className="flex gap-2">
                    <span aria-hidden="true" className="text-text-subtle">
                      •
                    </span>
                    <span>{describeScope(scope)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <GrantedAccessSection granted={granted} />
          </div>

          <div className="flex shrink-0 gap-3 border-t border-border-default p-4 sm:px-7 sm:py-5">
            {/*
              Two forms rather than one form with two named submit buttons: the
              decision then travels as an ordinary hidden field, so it does not
              depend on the button component forwarding `name`/`value` to the
              underlying element, and a form submitted by pressing Enter cannot
              be ambiguous about which action was taken.
            */}
            <form action="/oauth/consent" method="POST" className="flex-1">
              <input type="hidden" name="decision" value="deny" />
              <input type="hidden" name="request" value={signedRequest} />
              <Button type="submit" variant="outline" className="h-11 w-full font-semibold">
                Cancel
              </Button>
            </form>
            <form action="/oauth/consent" method="POST" className="flex-1">
              <input type="hidden" name="decision" value="allow" />
              <input type="hidden" name="request" value={signedRequest} />
              <Button type="submit" className="h-11 w-full font-semibold shadow-sm">
                Allow access
              </Button>
            </form>
          </div>
        </div>

        <p className="shrink-0 px-2 text-center text-xs text-text-subtle">
          You can revoke this access at any time. Compass never shares your password
          or sign-in method with {client.clientName}.
        </p>
      </div>
    </main>
  )
}

function UnverifiedNotice({ redirectHost, redirectUri }: { redirectHost: string; redirectUri: string }) {
  const loopback = redirectHost.startsWith("127.0.0.1") || redirectHost.startsWith("localhost")
  return (
    <div className="space-y-2 rounded-xl border border-status-warning/30 bg-status-warning-surface p-4">
      <p className="text-sm font-semibold text-status-warning">Unverified application</p>
      <p className="text-sm text-text-primary">
        Compass does not review or verify the applications that connect to it, and any
        application can choose its own name. Check where it is sending you:
      </p>
      <p className="break-all rounded-lg bg-surface-panel px-3 py-2 font-mono text-sm text-text-primary">
        {redirectUri}
      </p>
      <p className="text-sm text-text-subtle">
        {loopback
          ? "This is software running on your own computer. If you did not just start it, cancel."
          : `Access will be handed to ${redirectHost}. If you do not recognize it, cancel.`}
      </p>
    </div>
  )
}

function GrantedAccessSection({ granted }: { granted: GrantedAccessSummary }) {
  const { organizations, unresolvedMemberships } = granted

  if (organizations.length === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
          Where it will have access
        </h2>
        <p className="text-sm text-text-subtle">
          You are not currently a member of any organization or workspace, so this
          application will not be able to read or change anything yet. It will gain
          access to anything you are added to later.
        </p>
        <UnresolvedMembershipsNotice count={unresolvedMemberships} />
      </section>
    )
  }

  const workspaceCount = organizations.reduce((total, org) => total + org.workspaces.length, 0)
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Where it will have access
      </h2>
      <p className="text-sm text-text-primary">
        Everything you can reach — {organizations.length}{" "}
        {organizations.length === 1 ? "organization" : "organizations"} and {workspaceCount}{" "}
        {workspaceCount === 1 ? "workspace" : "workspaces"}, including any you join later:
      </p>
      <ul className="space-y-2 rounded-xl border border-border-default bg-surface-app p-3">
        {organizations.map((org) => (
          <li key={org.id} className="space-y-1">
            <p className="text-sm font-semibold text-text-primary">{org.name}</p>
            {org.workspaces.length > 0 ? (
              <ul className="ml-3 space-y-0.5">
                {org.workspaces.map((workspace) => (
                  <li key={workspace.id} className="text-sm text-text-subtle">
                    {workspace.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ml-3 text-sm text-text-subtle">
                Organization access only — no workspaces yet
              </p>
            )}
          </li>
        ))}
      </ul>
      <UnresolvedMembershipsNotice count={unresolvedMemberships} />
    </section>
  )
}

/**
 * Says out loud that the list above is incomplete.
 *
 * The enumeration is the compensating control for there being no workspace
 * picker, so a list that quietly omits a row is a weaker version of the problem
 * this screen exists to solve. A skipped membership points at a workspace that
 * no longer exists and therefore confers no access — but the user is told
 * rather than left to assume the list is exhaustive.
 */
function UnresolvedMembershipsNotice({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <p className="text-sm text-text-subtle">
      {count === 1
        ? "One membership on your account could not be shown"
        : `${count} memberships on your account could not be shown`}{" "}
      because the workspace or organization it points at no longer exists. Deleted
      workspaces grant no access, so nothing reachable is missing from this list.
    </p>
  )
}

function FatalError({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-app px-4">
      <div className="w-full max-w-md space-y-3 rounded-2xl border border-border-default bg-surface-panel p-8 text-center shadow-[var(--shadow-card)]">
        <h1 className="text-lg font-bold text-text-primary">{title}</h1>
        <p className="text-sm text-text-subtle">{detail}</p>
        <p className="text-sm text-text-subtle">
          Nothing has been shared. You can close this window.
        </p>
      </div>
    </main>
  )
}

/**
 * Plain-language scope descriptions.
 *
 * An unrecognised scope is shown verbatim rather than hidden: a consent screen
 * that silently drops a permission it does not have copy for would understate
 * the grant, which is the one failure mode this screen exists to prevent.
 */
function describeScope(scope: string): string {
  switch (scope) {
    case SCOPE_MCP_READ:
      return "Read your opportunities, solutions, roadmap, OKRs, research, feedback and docs"
    case SCOPE_MCP_WRITE:
      return "Create and change that same data on your behalf"
    case SCOPE_OFFLINE_ACCESS:
      return "Stay connected without asking you to sign in again"
    default:
      return scope
  }
}

/** Preserves repeated parameters so `validateAuthorizationRequest` can reject them. */
function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry)
    else if (typeof value === "string") params.append(key, value)
  }
  return params
}
