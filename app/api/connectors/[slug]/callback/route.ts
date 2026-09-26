// Completes the outbound OAuth flow for one third-party MCP connector (ADR-0018).
//
// This is where the grant is actually created, so this is where the security
// checks live. Three of them, in order:
//
//  1. **A session is required.** Not in `isPublicPath`, same as `connect`.
//  2. **`state` is claimed atomically** (`consumeAuthRequest`), so a replayed or
//     expired authorization request is refused rather than re-redeemed.
//  3. **The claimed request's `userId` must equal this session's user.** This is
//     the login-CSRF check, and it is the one that cannot be skipped: without it
//     an attacker completes their *own* consent at the provider, then delivers
//     the resulting callback URL to a victim, and the victim's Compass account
//     silently ends up driving the attacker's v0 account. Steps 1 and 2 both
//     pass in that scenario — only the ownership comparison catches it.
//
// Every outcome is a redirect rather than JSON, because a browser landed here
// from a consent screen and a raw JSON body is a dead end. Failures carry a
// short machine-readable code in the query string; the human-readable provider
// text stays in the server log, since it is untrusted and would otherwise be
// reflected into a page.
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import {
  DEFAULT_CONNECTOR_RETURN_PATH,
  McpConnectorError,
  connectorDefinition,
} from "@/lib/mcp-connectors/config"
import {
  CONNECTOR_CONNECTED_PARAM,
  CONNECTOR_ERROR_PARAM,
  CONNECTOR_PARAM,
} from "@/lib/mcp-connectors/notice"
import {
  consumeAuthRequest,
  findConnector,
  mcpConnectorsAvailable,
  saveGrant,
} from "@/lib/mcp-connectors/store"
import { exchangeAuthorizationCode } from "@/lib/mcp-connectors/tokens"
import { safeCallbackUrl } from "@/lib/safe-callback-url"

export const runtime = "nodejs"
export const maxDuration = 60

/** Provider-supplied error codes are echoed into a URL, so they are clamped to the OAuth charset. */
const PROVIDER_ERROR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params
  const params = request.nextUrl.searchParams

  const session = await auth()
  if (!session?.user?.id)
    // Not a redirect to /login: by the time we got here the single-use `state`
    // has already been spent at the provider, so sending the visitor round the
    // login loop would only land them back on a dead callback. Reconnecting from
    // the start is the honest instruction.
    return NextResponse.json({ error: "Sign in and start the connection again." }, { status: 401 })

  const definition = connectorDefinition(slug)
  if (!definition) return NextResponse.json({ error: `Unknown connector "${slug}".` }, { status: 404 })
  if (!(await mcpConnectorsAvailable()))
    return NextResponse.json({ error: "Connectors are not available on this deployment yet." }, { status: 503 })

  // The user declined, or the provider refused. Nothing to clean up — the
  // pending auth request expires on its own, and deleting it here would let an
  // unauthenticated guess at a `state` value cancel somebody's live flow.
  const providerError = params.get("error")
  if (providerError) {
    console.error("MCP connector authorization was refused", slug, providerError, params.get("error_description"))
    return failure(slug, DEFAULT_CONNECTOR_RETURN_PATH, sanitizeProviderError(providerError))
  }

  const state = params.get("state")
  const code = params.get("code")
  if (!state || !code) return failure(slug, DEFAULT_CONNECTOR_RETURN_PATH, "MISSING_PARAMETERS")

  try {
    const authRequest = await consumeAuthRequest(state)

    // Step 3. Compare against the session we resolved above, never against
    // anything in the request.
    if (authRequest.userId !== session.user.id) {
      console.error("MCP connector callback arrived under a different user than it was issued to", slug)
      return failure(slug, DEFAULT_CONNECTOR_RETURN_PATH, "WRONG_USER")
    }

    // `returnTo` is re-validated on the way out even though it was validated on
    // the way in: the row it came from is storage, and storage is not a
    // trust boundary this route gets to assume.
    const returnTo = safeCallbackUrl(authRequest.returnTo, DEFAULT_CONNECTOR_RETURN_PATH)

    // The connector is resolved from the *route* slug and the deployment's own
    // origin, then checked against the id the auth request was minted for. That
    // comparison is what stops a `state` issued for one connector being redeemed
    // against another connector's token endpoint — which would send the
    // authorization code, and the PKCE verifier with it, to the wrong provider.
    const origin = trustedCompassBaseUrl().origin
    const connector = await findConnector(slug, origin)
    if (!connector || connector.id !== authRequest.connectorId) {
      console.error("MCP connector callback slug does not match the connector the state was issued for", slug)
      return failure(slug, returnTo, "CONNECTOR_MISMATCH")
    }

    const tokens = await exchangeAuthorizationCode(connector, {
      code,
      codeVerifier: authRequest.codeVerifier,
      // From the stored row, so it byte-matches what the authorization endpoint
      // saw. Rebuilding it here would be both attacker-influenced and a
      // mismatch the token endpoint rejects.
      redirectUri: authRequest.redirectUri,
    })
    await saveGrant({ connectorId: connector.id, userId: session.user.id, ...tokens })

    return redirectTo(returnTo, { [CONNECTOR_PARAM]: slug, [CONNECTOR_CONNECTED_PARAM]: "1" })
  } catch (error) {
    if (error instanceof McpConnectorError) {
      // The message can quote a provider's response body, so it is logged, not
      // redirected. Only our own error code travels in the URL.
      console.error("MCP connector callback failed", slug, error.code, error.message)
      return failure(slug, DEFAULT_CONNECTOR_RETURN_PATH, error.code)
    }
    throw error
  }
}

function sanitizeProviderError(raw: string): string {
  return PROVIDER_ERROR_PATTERN.test(raw) ? raw : "AUTHORIZATION_FAILED"
}

function failure(slug: string, returnTo: string, code: string): NextResponse {
  return redirectTo(returnTo, { [CONNECTOR_PARAM]: slug, [CONNECTOR_ERROR_PARAM]: code })
}

function redirectTo(returnTo: string, query: Record<string, string>): NextResponse {
  // `returnTo` is already known root-relative, so resolving it against our own
  // trusted origin cannot escape it.
  const url = new URL(returnTo, trustedCompassBaseUrl().origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return NextResponse.redirect(url, { headers: { "Cache-Control": "no-store" } })
}
