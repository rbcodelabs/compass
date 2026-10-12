import { auth } from "@/auth"
import { getAllDocs, getDoc, searchHelp } from "@/lib/docs"

/**
 * Read-only access to the user-guide corpus (docs/content/*.md) for the agent
 * rail's Docs tab. lib/docs.ts is fs-based and server-only, so the client rail
 * reaches it through here. Same corpus the /help pages and the MCP
 * `search_help` / `get_help` tools serve.
 *
 *   GET /api/help            -> { topics }      every doc, in order
 *   GET /api/help?q=...      -> { results }     best section per doc
 *   GET /api/help?slug=...   -> { doc }         rendered HTML for one doc
 *
 * Signed-in users only. The /help pages are public, but this route is only ever
 * called from inside a workspace, so there is no reason to add an anonymous
 * search endpoint.
 */

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" }

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS })
  }

  const { searchParams } = new URL(request.url)
  const slug = searchParams.get("slug")
  const q = searchParams.get("q")

  if (slug !== null) {
    // Slugs are filenames; reject anything that could leave docs/content.
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
      return Response.json({ error: "Invalid slug" }, { status: 400, headers: NO_STORE_HEADERS })
    }
    const doc = await getDoc(slug)
    if (!doc) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS })
    return Response.json({ doc }, { headers: NO_STORE_HEADERS })
  }

  if (q !== null) {
    const query = q.trim().slice(0, 200)
    return Response.json({ results: query ? searchHelp(query, 8) : [] }, { headers: NO_STORE_HEADERS })
  }

  return Response.json({ topics: getAllDocs() }, { headers: NO_STORE_HEADERS })
}
