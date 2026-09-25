// Disconnects one third-party MCP connector for the signed-in user (ADR-0018).
//
// Order is deliberate and is the whole content of this route: **read the tokens,
// drop them locally, then tell the provider.** Compass's own copy is the thing
// the user asked to be rid of, so it goes first and unconditionally. The RFC 7009
// revocation that follows is a courtesy call whose failure must not make
// disconnect look broken — the connection is already gone from Compass whatever
// the provider says.
//
// The reverse order would be worse in the way that matters: a provider that
// times out would leave the grant live locally, and the user would be told the
// disconnect failed while Compass still held a usable token.
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { McpConnectorError, connectorDefinition } from "@/lib/mcp-connectors/config"
import {
  disconnectGrant,
  findConnector,
  findGrant,
  mcpConnectorsAvailable,
} from "@/lib/mcp-connectors/store"
import { revokeAtProvider } from "@/lib/mcp-connectors/tokens"

export const runtime = "nodejs"

export async function DELETE(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { slug } = await context.params
  if (!connectorDefinition(slug))
    return NextResponse.json({ error: `Unknown connector "${slug}".` }, { status: 404 })
  if (!(await mcpConnectorsAvailable()))
    // Nothing can be connected if the tables do not exist, so this is already
    // the state the caller asked for.
    return NextResponse.json({ disconnected: false, revokedAtProvider: false })

  const origin = trustedCompassBaseUrl().origin
  const connector = await findConnector(slug, origin)
  if (!connector) return NextResponse.json({ disconnected: false, revokedAtProvider: false })

  // Read before deleting, because `disconnectGrant` blanks both ciphertexts and
  // there is no way to revoke a token that has already been dropped. Tolerated
  // failure: if the encryption key is missing or rotated, the grant cannot be
  // decrypted — but the user still gets their disconnect, just without the
  // provider-side revocation.
  let tokens: { refreshToken: string | null; accessToken: string } | null = null
  try {
    const grant = await findGrant(connector.id, session.user.id)
    if (grant) tokens = { refreshToken: grant.refreshToken, accessToken: grant.accessToken }
  } catch (error) {
    console.error(
      "MCP connector tokens could not be read before disconnect; skipping provider revocation",
      slug,
      error instanceof McpConnectorError ? error.code : error,
    )
  }

  const disconnected = await disconnectGrant(connector.id, session.user.id)

  // Prefer the refresh token: revoking it invalidates the whole grant at most
  // providers, whereas revoking an access token leaves the refresh token able to
  // mint another one.
  let revokedAtProvider = false
  if (tokens) revokedAtProvider = await revokeAtProvider(connector, tokens.refreshToken ?? tokens.accessToken)

  return NextResponse.json({ disconnected, revokedAtProvider }, { headers: { "Cache-Control": "no-store" } })
}
