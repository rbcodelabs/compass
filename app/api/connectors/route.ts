// The connector catalog and this user's connection state (ADR-0018).
//
// Session-authed and per-user: a grant belongs to one Compass user, not to a
// workspace, because the token it wraps acts as *that person* inside the third
// party's product. Two users on the same workspace each connect their own v0
// account.
//
// Reads are tolerant of the migration being unapplied — `listConnectedSlugs`
// answers `[]` on a missing table — so the catalog renders with everything
// showing as not connected instead of erroring. `available` tells the UI which
// of the two situations it is looking at.
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { CONNECTOR_DEFINITIONS } from "@/lib/mcp-connectors/config"
import { listConnectedSlugs, mcpConnectorsAvailable } from "@/lib/mcp-connectors/store"

export const runtime = "nodejs"

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const available = await mcpConnectorsAvailable()
  // Connections are scoped to the origin that registered them, so a preview
  // deployment must not report a production grant as connected — its `client_id`
  // and `redirect_uri` belong to a different registration entirely.
  const origin = trustedCompassBaseUrl().origin
  const connected = available ? new Set(await listConnectedSlugs(session.user.id, origin)) : new Set<string>()

  return NextResponse.json(
    {
      available,
      connectors: CONNECTOR_DEFINITIONS.map(definition => ({
        slug: definition.slug,
        displayName: definition.displayName,
        serverUrl: definition.serverUrl,
        connected: connected.has(definition.slug),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
