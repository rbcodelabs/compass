/**
 * `GET /.well-known/openid-configuration` — the OIDC Discovery spelling of the
 * same RFC 8414 document served at `/.well-known/oauth-authorization-server`.
 *
 * Compass is **not** an OpenID Provider: it issues no ID token and has no
 * UserInfo endpoint, and the document below advertises neither. This path
 * exists solely because MCP clients MUST support both discovery spellings and
 * several probe this one first. Serving the OAuth metadata here is what the MCP
 * authorization spec asks for; it is not a claim to OIDC conformance.
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
