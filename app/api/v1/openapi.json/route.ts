import { buildOpenApiDocument } from "@/lib/rest/openapi"

export const dynamic = "force-static"

export async function GET() {
  return Response.json(buildOpenApiDocument(), { headers: { "Cache-Control": "public, max-age=300" } })
}
