/**
 * `GET /.well-known/oauth-protected-resource` — the root-path protected
 * resource document.
 *
 * Byte-identical to the path-inserted document served at
 * `/.well-known/oauth-protected-resource/api/mcp`. The MCP spec's client
 * fallback order is path-inserted → root, so a client that skips insertion, or
 * that was pointed at the origin rather than the resource URL, still finds it
 * here.
 */
import { protectedResourceMetadata } from "@/lib/oauth/metadata"
import { corsPreflightResponse, withMetadataConfiguration } from "@/lib/oauth/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return withMetadataConfiguration(protectedResourceMetadata)
}

export async function OPTIONS() {
  return corsPreflightResponse("GET")
}
