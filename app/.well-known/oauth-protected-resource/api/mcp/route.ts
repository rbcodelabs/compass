/**
 * `GET /.well-known/oauth-protected-resource/api/mcp` — RFC 9728 §3.1
 * path-inserted protected resource metadata.
 *
 * **This is the mandatory half of the pair, not the optional one.** The Geode
 * broker calls `discoverOAuthServerInfo(entry.authorizationServerUrl ?? entry.url)`
 * and falls back to the *resource* URL, at which point the MCP SDK performs
 * RFC 9728 path insertion and asks for exactly this path. Serving only the root
 * document would leave the primary consumer unable to discover anything.
 *
 * Routing note: Next 16.2.6 filters only `_`-prefixed segments during route
 * discovery (`ignorePartFilter: (part) => part.startsWith('_')`), so a
 * `.well-known` directory under `app/` is discovered normally. The fallback, if
 * that ever changes, is a `next.config.ts` rewrite.
 */
import { protectedResourceMetadata } from "@/lib/oauth/metadata"
import { corsPreflightResponse, withMetadataConfiguration } from "@/lib/oauth/http"

export const runtime = "nodejs"
// Never prerendered: the document is derived from the deployment origin, which
// is a runtime value. Repeat fetches are absorbed by the Cache-Control header
// metadataResponse sets, which is what keeps this inside Claude's 10 s budget.
export const dynamic = "force-dynamic"

export async function GET() {
  return withMetadataConfiguration(protectedResourceMetadata)
}

export async function OPTIONS() {
  return corsPreflightResponse("GET")
}
