// The connector catalog and this user's connection state (ADR-0018).
//
// Session-authed and per-user: a grant belongs to one Compass user, not to a
// workspace, because the token it wraps acts as *that person* inside the third
// party's product. Two users on the same workspace each connect their own v0
// account.
//
// Reads are tolerant of the migration being unapplied — `listConnectedGrants`
// answers `[]` on a missing table — so the catalog renders with everything
// showing as not connected instead of erroring. `available` tells the UI which
// of the two situations it is looking at.
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { CONNECTOR_DEFINITIONS, connectorAccessView, isConnectorConfigured } from "@/lib/mcp-connectors/config"
import { mcpConnectorsAvailable } from "@/lib/mcp-connectors/store"
import { listConnections } from "@/lib/mcp-connectors/vercel-connect"

export const runtime = "nodejs"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const available = await mcpConnectorsAvailable()
  // Connections are scoped to the origin that registered them, so a preview
  // deployment must not report a production grant as connected — its `client_id`
  // and `redirect_uri` belong to a different registration entirely.
  const origin = trustedCompassBaseUrl().origin
  // Connect-backed connectors need no migration, so they are probed either way.
  const grants = await listConnections(session.user.id, origin, undefined, available)
  const scopeBySlug = new Map(grants.map(grant => [grant.slug, grant.scope]))

  return NextResponse.json(
    {
      available,
      connectors: CONNECTOR_DEFINITIONS.map(definition => ({
        slug: definition.slug,
        displayName: definition.displayName,
        serverUrl: definition.serverUrl,
        connected: scopeBySlug.has(definition.slug),
        // The choice offered at Connect time and, when connected, the level held.
        ...connectorAccessView(definition, scopeBySlug.get(definition.slug)),
        // False when a static-client connector lacks its env vars on this
        // deployment; the UI shows it as unavailable instead of a dead link.
        configured: isConnectorConfigured(definition),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
