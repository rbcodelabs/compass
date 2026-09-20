/**
 * `GET /.well-known/oauth-authorization-server` — RFC 8414 authorization
 * server metadata. The primary probe for a path-less issuer.
 *
 * Served byte-identically at `/.well-known/openid-configuration`; MCP clients
 * MUST support both spellings and different clients try different ones first.
 */
import { authorizationServerMetadata } from "@/lib/oauth/metadata"
import { corsPreflightResponse, withMetadataConfiguration } from "@/lib/oauth/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return withMetadataConfiguration(authorizationServerMetadata)
}

export async function OPTIONS() {
  return corsPreflightResponse("GET")
}
