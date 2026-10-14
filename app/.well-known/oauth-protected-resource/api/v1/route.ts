import { protectedResourceMetadata } from "@/lib/oauth/metadata"
import { corsPreflightResponse, withMetadataConfiguration } from "@/lib/oauth/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return withMetadataConfiguration(() => protectedResourceMetadata("api"))
}

export async function OPTIONS() { return corsPreflightResponse("GET") }
