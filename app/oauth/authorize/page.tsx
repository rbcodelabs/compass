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
 *
 * ## What ADR 0015 changed here
 *
 * Two things, both of them load-bearing.
 *
 * **The screen now asks which identity the connection acts as.** Phase 1 minted
 * `purpose: "USER"` tokens unconditionally, which routed around the entire
 * agent authorization model — grant-scoped workspace reach, the "Human
 * administrator required." assertions, the 17 human-only tools, and the
 * per-call audit trail. The binding section is where that is chosen, and
 * "Where it will have access" is now computed from the chosen binding's
 * *effective reach* rather than from every membership the user holds. See
 * `app/oauth/authorize/consent-form.tsx`.
 *
 * **The `__Host-` consent cookie short-circuit is gone.** A remembered approval
 * now carries a binding, which makes it a security-relevant decision, and a
 * security-relevant decision may not live in 90-day client state that no
 * server-side migration can reach. `OAuthConsent` is the single source of truth
 * for remembered consent, and a remembered binding is re-validated before it is
 * replayed — an agent suspended since the last authorization sends the user
 * back to this screen rather than minting a token that 401s on its first call.
 */
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { CompassUrlNotConfiguredError } from "@/lib/compass-url"
import {
  buildAuthorizationErrorUrl,
  buildAuthorizationSuccessUrl,
  validateAuthorizationRequest,
} from "@/lib/oauth/authorize-request"
import {
  inlineGrantAccess,
  loadConsentBindingOptions,
  revalidateRememberedBinding,
} from "@/lib/oauth/agent-binding"
import { issueAuthorizationCodeWithEvent } from "@/lib/oauth/authorization-events"
import {
  findStoredConsent,
  grantedAccess,
  signAuthorizationRequest,
  type GrantedAccessSummary,
} from "@/lib/oauth/consent"
import { SCOPE_MCP_READ, SCOPE_MCP_WRITE, SCOPE_OFFLINE_ACCESS, parseScope } from "@/lib/oauth/constants"
import { ConsentForm } from "./consent-form"

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

  // One record of a previous approval, not two. The `__Host-` cookie that used
  // to be ORed in here is gone (ADR 0015): it was a 90-day, non-revocable
  // second source of truth for what is now a security-relevant decision, and
  // no server-side migration could reach it — leaving it in place would have
  // made this entire change a silent no-op on the one browser that authorized
  // the over-privileged connection. `OAuthConsent` is durable, inspectable and
  // revocable, and the cost of losing the cookie is one primary-key read.
  const stored = await findStoredConsent(userId, request.clientId, requestedScopes)
  if (stored) {
    // The remembered *binding* is replayed, not just the approval — but only
    // after it is re-checked against the world as it is now. An agent that has
    // since been suspended, deleted or stripped of every grant returns null
    // here, and the user drops through to the screen instead of receiving a
    // code that fails on its first call with no indication it must re-consent.
    const binding = await revalidateRememberedBinding(stored, userId)
    if (binding) {
      const { code } = await issueAuthorizationCodeWithEvent(
        { ...request, userId, ...binding },
        { source: "REMEMBERED_CONSENT", clientNameSnapshot: client.clientName },
      )
      redirect(
        buildAuthorizationSuccessUrl({ redirectUri: request.redirectUri, code, state: request.state }),
      )
    }
  }

  const [granted, bindingOptions] = await Promise.all([
    grantedAccess(userId),
    loadConsentBindingOptions(userId),
  ])
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

    ADR 0015 adds a whole binding section above the action row, which is exactly
    the kind of growth that quietly reintroduces the original bug — so the
    structure is preserved rather than reasoned about again: `main` still owns
    the viewport, the scroll region still scrolls, and the action row is still
    its sibling. It now lives inside ConsentForm because the primary button's
    label, styling and disabled state all depend on the current selection.
  */
  return (
    <main className="flex h-dvh items-center justify-center overflow-hidden bg-surface-app px-4 py-6">
      <div className="flex max-h-full w-full max-w-lg flex-col gap-3">
        <ConsentForm
          signedRequest={signedRequest}
          options={bindingOptions}
          inlineAccess={inlineGrantAccess(requestedScopes)}
          userEmail={session?.user?.email ?? null}
          details={
            <>
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
            </>
          }
          overrideReach={<GrantedAccessSection granted={granted} />}
        />

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

/**
 * The full membership enumeration.
 *
 * Phase 1 rendered this as the whole of "Where it will have access", because a
 * user-mode token really did reach every membership. Under ADR 0015 it is the
 * reach of **one specific choice** — the admin override — so it no longer owns
 * that heading and no longer appears unconditionally. It is passed into
 * ConsentForm and rendered inside the override panel, and as the reach display
 * when the override is armed. The enumeration itself is unchanged, including
 * the "could not be shown" disclosure, because it is still the compensating
 * control for the breadth of the thing it describes.
 */
function GrantedAccessSection({ granted }: { granted: GrantedAccessSummary }) {
  const { organizations, unresolvedMemberships } = granted

  if (organizations.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-text-subtle">
          You are not currently a member of any organization or workspace, so this
          application will not be able to read or change anything yet. It will gain
          access to anything you are added to later.
        </p>
        <UnresolvedMembershipsNotice count={unresolvedMemberships} />
      </div>
    )
  }

  const workspaceCount = organizations.reduce((total, org) => total + org.workspaces.length, 0)
  return (
    <div className="space-y-2">
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
    </div>
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
