// Starts the outbound OAuth flow for one third-party MCP connector (ADR-0018).
//
// Session-authed, and deliberately **not** in `lib/route-access.ts`'s public
// list: the middleware's login redirect preserves the query string and returns
// the visitor here afterwards, which is exactly the behaviour
// `/oauth/authorize` relies on for the inbound direction. A signed-out visitor
// following a connect link should end up signed in and then connected, not at a
// 401 they cannot act on.
//
// GET rather than POST because this is a link a browser follows to a third
// party's consent screen. That makes it CSRF-reachable, and the consequence is
// bounded on purpose: the only effect is a redirect plus a row in
// `mcp_connector_auth_requests`. Nothing is granted until the *callback* runs,
// and the callback re-checks that the session it arrives under is the same user
// the request was issued to — which is where login-CSRF is actually stopped.
import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/auth"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import {
  DEFAULT_CONNECTOR_RETURN_PATH,
  McpConnectorError,
  connectorDefinition,
  connectorRedirectUri,
} from "@/lib/mcp-connectors/config"
import {
  createAuthRequest,
  ensureConnector,
  mcpConnectorsAvailable,
  pruneExpiredAuthRequests,
} from "@/lib/mcp-connectors/store"
import { buildAuthorizeUrl } from "@/lib/mcp-connectors/tokens"
import { safeCallbackUrl } from "@/lib/safe-callback-url"

export const runtime = "nodejs"
// The first connect from a fresh origin does discovery (two metadata fetches)
// plus Dynamic Client Registration before it can redirect; every subsequent one
// reads a single row. The ceiling is for that cold case — each third-party call
// is individually capped at 10 s by lib/mcp-connectors/http.ts.
export const maxDuration = 60

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { slug } = await context.params
  if (!connectorDefinition(slug))
    return NextResponse.json({ error: `Unknown connector "${slug}".` }, { status: 404 })

  if (!(await mcpConnectorsAvailable()))
    return NextResponse.json(
      {
        error:
          "Connectors are not available on this deployment yet (migration 062_mcp_connectors is unapplied).",
      },
      { status: 503 },
    )

  // The deployment's own origin, never a request header. It is half the
  // connector's key precisely because `redirect_uri` is matched by exact string
  // at the provider, so a value taken from `x-forwarded-host` would let a
  // spoofed header register a client for an origin Compass does not own.
  const origin = trustedCompassBaseUrl().origin
  const redirectUri = connectorRedirectUri(slug, origin)

  try {
    const connector = await ensureConnector(slug, origin, redirectUri)
    const { state, codeVerifier } = await createAuthRequest({
      connectorId: connector.id,
      userId: session.user.id,
      redirectUri,
      // Validated here *and* again at the callback. An unvalidated returnTo
      // would make this route an open redirect that launders through a third
      // party's consent screen. `safeCallbackUrl` substitutes its fallback
      // rather than throwing, so a hostile value degrades to the default page
      // instead of failing the connection.
      returnTo: safeCallbackUrl(
        request.nextUrl.searchParams.get("returnTo"),
        DEFAULT_CONNECTOR_RETURN_PATH,
      ),
    })
    // Opportunistic and unawaited: expired rows are dead weight, there is no
    // cron for this feature, and a failure here must not fail the connect.
    void pruneExpiredAuthRequests().catch(() => {})
    return NextResponse.redirect(buildAuthorizeUrl(connector, { state, codeVerifier, redirectUri }), {
      // No-store so a back-navigation re-enters this route and mints a fresh
      // state instead of replaying a consumed one out of the browser's cache.
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    if (error instanceof McpConnectorError)
      return NextResponse.json({ error: error.message, code: error.code }, { status: 502 })
    throw error
  }
}
