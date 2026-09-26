// The sandbox-facing MCP gateway (ADR-0018).
//
// The cloud agent is handed `<compass>/api/integrations/mcp/<slug>` and its own
// 5-minute `AGENT_TURN` bearer. This route exchanges that for the signed-in
// user's third-party access token and forwards the MCP request, so no v0 token
// ever enters the microVM. See lib/mcp-connectors/gateway.ts for why both header
// directions are closed allowlists.
//
// Three properties are load-bearing:
//
//  1. **Only an `AGENT_TURN` credential may use this.** Not a static `cmp_…`
//     user key, not a service key, not an OAuth access token. A turn credential
//     is server-minted, expires in minutes, and belongs to exactly the user whose
//     grant is about to be spent. Widening this to any valid bearer would let a
//     long-lived key act inside a third party indefinitely.
//  2. **The grant is resolved from the credential's own `userId`**, never from
//     anything in the request. There is no path by which a turn credential for
//     user A reaches user B's v0 account.
//  3. **A 401 from the provider is retried exactly once**, after a refresh. Once,
//     because the second 401 is the provider telling us the grant is gone, and a
//     loop would spend refresh tokens against a wall.
import { NextRequest, NextResponse } from "next/server"
import { McpConnectorError, connectorDefinition } from "@/lib/mcp-connectors/config"
import {
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADERS,
  GATEWAY_TIMEOUT_MS,
  MAX_GATEWAY_REQUEST_BYTES,
  pickHeaders,
} from "@/lib/mcp-connectors/gateway"
import { requireHttpsUrl } from "@/lib/mcp-connectors/http"
import { findGrant, mcpConnectorsAvailable } from "@/lib/mcp-connectors/store"
import { refreshGrant, resolveConnectorToken } from "@/lib/mcp-connectors/tokens"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { validateMcpAuth } from "@/lib/mcp-auth"

export const runtime = "nodejs"
// A proxied tool call can be slow. This is a chosen ceiling rather than a platform
// one — see GATEWAY_TIMEOUT_MS in lib/mcp-connectors/gateway.ts for why it was not
// raised, and what a provider is steered toward instead.
export const maxDuration = 60

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  return proxy(request, context)
}

/** The streamable-HTTP transport opens its server→client stream with a GET. */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  return proxy(request, context)
}

/** And terminates the session with a DELETE. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  return proxy(request, context)
}

async function proxy(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params
  if (!connectorDefinition(slug)) return jsonRpcError(404, -32601, `Unknown connector "${slug}".`)

  const authResult = await validateMcpAuth(request)
  // `purpose` is checked against the one exact value, not a list minus the ones
  // we dislike: a new purpose added to `McpAuthResult` must be explicitly
  // admitted here rather than inheriting access.
  if (!authResult.valid || authResult.purpose !== "AGENT_TURN" || !authResult.userId)
    return jsonRpcError(401, -32001, "This endpoint requires an agent turn credential.")
  const userId = authResult.userId

  if (!(await mcpConnectorsAvailable()))
    return jsonRpcError(503, -32002, "Connectors are not available on this deployment.")

  // Buffered so the request can be replayed after a refresh. A GET or DELETE
  // carries no body, and `request.arrayBuffer()` on one yields zero bytes.
  let body: ArrayBuffer | undefined
  if (request.method === "POST") {
    body = await request.arrayBuffer()
    if (body.byteLength > MAX_GATEWAY_REQUEST_BYTES)
      return jsonRpcError(413, -32003, "Request body is too large to proxy.")
  }

  try {
    const origin = trustedCompassBaseUrl().origin
    const resolved = await resolveConnectorToken(slug, origin, userId)
    if (!resolved)
      // Ordinary state, not a fault: the user has not connected this provider.
      // The message is written for the agent, which will surface it to the user.
      return jsonRpcError(
        403,
        -32004,
        `You have not connected ${connectorDefinition(slug)?.displayName ?? slug} to Compass. Connect it in Settings → My agents, then try again.`,
      )

    let upstream = await forward(resolved.connector.serverUrl, request, body, resolved.accessToken)

    // Retry once, and only on a 401. A provider can revoke or expire a token
    // early — before the `expires_at` Compass recorded — so a 401 here does not
    // mean the stored expiry was wrong, it means the provider changed its mind.
    if (upstream.status === 401) {
      // Drain the discarded response so the connection is not left dangling.
      await upstream.body?.cancel().catch(() => {})
      const grant = await findGrant(resolved.connector.id, userId)
      if (!grant) return jsonRpcError(403, -32004, "This connection was removed while the turn was running.")
      const refreshed = await refreshGrant(resolved.connector, grant)
      upstream = await forward(resolved.connector.serverUrl, request, body, refreshed)
      if (upstream.status === 401) {
        await upstream.body?.cancel().catch(() => {})
        return jsonRpcError(
          502,
          -32005,
          `${resolved.connector.displayName} rejected a freshly refreshed token. Reconnect it in Settings → My agents.`,
        )
      }
    }

    // Streamed rather than buffered: an SSE response has no end until the server
    // closes it, and buffering would both stall the agent and hold the whole
    // stream in memory.
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: pickHeaders(upstream.headers, FORWARDED_RESPONSE_HEADERS),
    })
  } catch (error) {
    if (error instanceof McpConnectorError) {
      const displayName = connectorDefinition(slug)?.displayName ?? slug
      // The message can quote a provider response body, so it is logged rather
      // than returned. The agent gets the code and an instruction it can act on.
      console.error("MCP connector gateway failed", slug, error.code, error.message)
      // A timeout is not a failure report about the provider, and saying so cost a
      // real user: the first long v0 generation was aborted here, the agent read
      // `GATEWAY_FAILED` as "v0 is unreachable", and told the user to go rebuild by
      // hand an app v0 had in fact already finished building. What the agent needs
      // is the instruction to go *look* before retrying.
      if (error.code === "GATEWAY_TIMEOUT")
        return jsonRpcError(
          504,
          -32007,
          `This ${displayName} call ran longer than Compass will hold a request open (${Math.round(GATEWAY_TIMEOUT_MS / 1000)}s), so the response was lost. ` +
            `The work may have completed at ${displayName} anyway — use its list or get tools to check for the result before doing anything again, ` +
            `and prefer ${displayName}'s asynchronous mode for work that takes this long. Do not tell the user it failed until you have checked.`,
        )
      return jsonRpcError(502, -32006, `The ${slug} connection failed (${error.code}).`)
    }
    throw error
  }
}

async function forward(
  serverUrl: string,
  request: NextRequest,
  body: ArrayBuffer | undefined,
  accessToken: string,
): Promise<Response> {
  const headers = pickHeaders(request.headers, FORWARDED_REQUEST_HEADERS)
  headers.set("Authorization", `Bearer ${accessToken}`)
  // The stored value came from the reviewed catalog via `ensureConnector`, but it
  // is re-checked on the way out anyway: this is the one call that carries a live
  // third-party bearer, so "the row must be fine" is not a good enough reason to
  // skip the scheme check.
  const target = requireHttpsUrl(serverUrl, "serverUrl", "GATEWAY_FAILED")

  let response: Response
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body,
      // A redirect on the MCP endpoint would carry the third-party bearer to a
      // host that no origin check ever saw. Same rule as every other outbound
      // call in this feature — see lib/mcp-connectors/http.ts.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
  } catch (error) {
    // A timeout is reported as its own code. `AbortSignal.timeout` rejects with a
    // DOMException named "TimeoutError"; an abort from anywhere else is named
    // "AbortError" and is not this case. The distinction matters because the
    // provider has *not* necessarily failed — it may still be working, and may
    // well finish — so the advice the agent needs is the opposite of the advice
    // for an unreachable host.
    if (error instanceof Error && error.name === "TimeoutError")
      throw new McpConnectorError(
        "GATEWAY_TIMEOUT",
        `${serverUrl} did not answer within ${GATEWAY_TIMEOUT_MS} ms.`,
      )
    throw new McpConnectorError(
      "GATEWAY_FAILED",
      `${serverUrl} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    throw new McpConnectorError(
      "GATEWAY_FAILED",
      `${serverUrl} redirected (${response.status}); Compass does not follow redirects while carrying a bearer token.`,
    )
  }
  return response
}

/**
 * Errors are shaped as JSON-RPC so the agent's MCP client reports something
 * intelligible instead of "unexpected response". The HTTP status is still set —
 * the transport reads it — but the body is what reaches the model, so it carries
 * the instruction (`connect it in Settings`) rather than a bare code.
 */
function jsonRpcError(status: number, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
