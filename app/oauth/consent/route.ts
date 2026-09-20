/**
 * `POST /oauth/consent` — the approve/deny half of the authorization endpoint.
 *
 * Deliberately **not** in `isPublicPath`, like `/oauth/authorize`: it runs under
 * the Auth.js session and has no business being reachable without one.
 *
 * ## The request is a signature; the binding is not — and that is deliberate
 *
 * The form posts `decision` and `request`, where `request` is the HMAC-signed
 * blob minted by the page. Everything that determines *what is being authorized*
 * — client, redirect URI, scope, PKCE challenge, audience, `state` — is
 * recovered from inside that signature, not from form fields. Both properties
 * that matter fall out of that one choice:
 *
 *  - **CSRF.** The blob is bound to `session.user.id`. A cross-site form has no
 *    way to mint one, and a blob captured from another user's screen fails
 *    verification. No separate token, no double-submit cookie.
 *  - **No tamper window on the request.** The redirect URI the user read on the
 *    consent screen is provably the redirect URI the code is sent to. Swapping
 *    `127.0.0.1` for `evil.com` between the screen and the submit is the
 *    canonical version of this attack and it still has nowhere to land.
 *
 * ADR 0015 adds fields the signature **cannot** cover, and the module doc says
 * so rather than leaving it implicit. `binding`, `agentId`, `agentName`,
 * `grantWorkspaceId` and `confirmation` are choices the human makes *at* the
 * consent screen, so the GET that signed the blob could not have known them.
 * They arrive unsigned.
 *
 * That is a real weakening of the original invariant, and the resolution is
 * that **every unsigned field is re-validated server-side against the session
 * user** rather than trusted: the named agent must be one of the caller's own
 * live agents, each granted workspace must pass `resolveWorkspaceAdmin`, the
 * override predicate must hold now, and the typed confirmation must equal the
 * caller's own email. The worst a tampered field can therefore achieve is a
 * binding the user was independently entitled to choose — a materially
 * different class of outcome from redirecting the code somewhere else, which is
 * the line worth drawing. See `lib/oauth/agent-binding.ts`.
 *
 * The request is re-validated against the database anyway (`client_id` still
 * exists, `redirect_uri` still registered, scope still available). A signature
 * proves the request was authentic when it was rendered, not that it is still
 * authorized ten minutes later — which is the same reason the unsigned fields
 * are re-validated rather than signed in a second round trip.
 */
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { createAgent, grantWorkspaceAgent } from "@/app/settings/agents/actions"
import { CompassUrlNotConfiguredError } from "@/lib/compass-url"
import getPrisma from "@/lib/db"
import {
  buildAuthorizationErrorUrl,
  buildAuthorizationSuccessUrl,
} from "@/lib/oauth/authorize-request"
import { loadConsentBindingOptions, resolveConsentBinding } from "@/lib/oauth/agent-binding"
import { issueAuthorizationCodeWithEventInTransaction } from "@/lib/oauth/authorization-events"
import { findOAuthClient } from "@/lib/oauth/clients"
import { recordConsent, verifyAuthorizationRequest } from "@/lib/oauth/consent"
import { parseScope } from "@/lib/oauth/constants"
import { oauthConfigurationErrorResponse, oauthErrorResponse } from "@/lib/oauth/errors"
import { OAUTH_NO_STORE_HEADERS, formField, readFormBody } from "@/lib/oauth/http"
import { matchRedirectUri } from "@/lib/oauth/redirect-uri"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) {
    return oauthErrorResponse("access_denied", "You must be signed in to authorize an application.", 401)
  }

  let params: URLSearchParams
  try {
    params = await readFormBody(request)
  } catch {
    return oauthErrorResponse("invalid_request", "Request body is too large or unreadable.", 400)
  }

  const pending = verifyAuthorizationRequest(formField(params, "request"), userId)
  if (!pending) {
    // Covers a forged blob, one signed for a different user, and one that simply
    // expired. None of them is distinguishable to a legitimate client, and the
    // user's remedy is identical: start the authorization again.
    return oauthErrorResponse(
      "invalid_request",
      "This authorization request has expired or is not valid. Start again from the application.",
      400,
    )
  }

  // Re-check the client between render and submit. A client pruned or a
  // redirect URI de-registered in that window must not still receive a code.
  const client = await findOAuthClient(pending.clientId)
  if (!client || !matchRedirectUri(client.redirectUris, pending.redirectUri)) {
    return oauthErrorResponse(
      "invalid_client",
      "This application is no longer registered. Start again from the application.",
      400,
    )
  }

  let location: string
  try {
    if (formField(params, "decision") !== "allow") {
      // Anything that is not an explicit allow is a denial — a missing or
      // unexpected value must never be read as approval. `access_denied` is the
      // RFC 6749 §4.1.2.1 code, and the client is told rather than left hanging.
      location = buildAuthorizationErrorUrl({
        redirectUri: pending.redirectUri,
        error: "access_denied",
        description: "The user declined to authorize this application.",
        state: pending.state,
      })
      return redirectResponse(location)
    }

    // Recomputed here rather than carried from the screen. Options built at
    // render time are ten minutes stale by the deadline on the signed blob, and
    // every one of them — agent liveness, grant state, workspace admin rights,
    // the override predicate — can change inside that window.
    const options = await loadConsentBindingOptions(userId)
    const resolved = await resolveConsentBinding(
      {
        binding: formField(params, "binding"),
        agentId: formField(params, "agentId"),
        agentName: formField(params, "agentName"),
        grantWorkspaceIds: params.getAll("grantWorkspaceId"),
        confirmation: formField(params, "confirmation"),
      },
      {
        userId,
        userEmail: session?.user?.email ?? null,
        requestedScopes: parseScope(pending.scope),
        options,
      },
      consentBindingEffects,
    )
    if (!resolved.ok) {
      // Not delivered to the client as `access_denied`: nothing was denied, and
      // sending the user back to the application would lose the reason. The
      // remedy is on this side of the redirect — grant the agent access, or
      // start again — so the message stays here, exactly as it does for an
      // expired blob or a de-registered redirect URI above.
      return oauthErrorResponse("invalid_request", resolved.message, 400)
    }

    let code: string
    try {
      const prisma = getPrisma()
      code = await prisma.$transaction(async (tx) => {
        await recordConsent(userId, pending.clientId, pending.scope, resolved.binding, tx)
        const issued = await issueAuthorizationCodeWithEventInTransaction(
          { ...pending, userId, ...resolved.binding },
          { source: "INTERACTIVE_CONSENT", clientNameSnapshot: client.clientName },
          new Date(),
          tx,
        )
        return issued.code
      })
    } catch (error) {
      // Inline creation is part of this authorization attempt, not a Settings
      // operation the user asked to keep independently. If persistence fails
      // after the grants succeeded, compensate before surfacing the original
      // failure so an incomplete authorization leaves no new agent behind.
      if (resolved.createdAgentId) {
        await consentBindingEffects.deleteAgent(resolved.createdAgentId).catch(() => {})
      }
      throw error
    }
    location = buildAuthorizationSuccessUrl({
      redirectUri: pending.redirectUri,
      code,
      state: pending.state,
    })
  } catch (error) {
    if (error instanceof CompassUrlNotConfiguredError) return oauthConfigurationErrorResponse()
    throw error
  }

  // No cookie is written, on approval or otherwise. ADR 0015 retired the
  // `__Host-` consent cookie entirely: a remembered approval now carries a
  // binding, and a binding is not something that may live in 90-day client
  // state no server-side revocation can reach. `OAuthConsent`, written just
  // above, is the only record.
  return redirectResponse(location)
}

/**
 * The write half of an inline agent creation, routed through the **same server
 * actions Settings uses** rather than a second grant path.
 *
 * `grantWorkspaceAgent` re-runs `resolveWorkspaceAdmin` for every workspace and
 * carries the membership-touch concurrency guard (app/settings/agents/actions.ts:76-77)
 * that stops a grant committing after the owner's membership has been removed.
 * Re-implementing either of those here would mean two places that decide who
 * may grant what, and they would drift.
 *
 * `deleteAgent` exists only to roll back inline creation: either a later grant
 * failed in `resolveConsentBinding`, or consent/code persistence failed after
 * every grant succeeded. It is deliberately not a Settings action, because
 * "delete an agent" is not an operation Settings offers — suspension is.
 */
const consentBindingEffects = {
  createAgent: (name: string) => createAgent({ name }),
  grantWorkspace: (
    orgSlug: string,
    workspaceSlug: string,
    agentId: string,
    access: "READ" | "WRITE",
  ) => grantWorkspaceAgent(orgSlug, workspaceSlug, agentId, access),
  deleteAgent: async (agentId: string) => {
    const prisma = getPrisma()
    // Aurora DSQL uses relationMode="prisma": deleting Agent does not cascade
    // to grants. Inline creation cannot have acquired keys, runtime state, or
    // tool-call history yet, but it may have completed earlier grants before a
    // later grant failed, so those rows must be removed explicitly first.
    await prisma.agentWorkspaceGrant.deleteMany({ where: { agentId } })
    await prisma.agent.delete({ where: { id: agentId } })
  },
}

/**
 * 303, not 302. The browser arrived here by POST; 303 is the status that
 * mandates following up with a GET, which is what a `redirect_uri` — a loopback
 * callback server or a hosted callback page — is listening for.
 */
function redirectResponse(location: string): NextResponse {
  return NextResponse.redirect(location, { status: 303, headers: OAUTH_NO_STORE_HEADERS })
}
