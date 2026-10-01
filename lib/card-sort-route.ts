import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { CARD_SORT_ERROR_STATUS, CardSortError } from "@/lib/card-sort"

/**
 * Shared auth + error plumbing for the card sort routes.
 *
 * Every route funnels through `withCardSortContext` so the membership check and
 * the CardSortError → status mapping exist in exactly one place. Repeating them
 * per route is how one endpoint eventually ends up missing the membership check
 * while the other four have it.
 */

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" }

export type CardSortContext = { userId: string; workspaceId: string }

export async function withCardSortContext(
  request: Request,
  handler: (context: CardSortContext) => Promise<unknown>
): Promise<Response> {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS })
  }

  const { searchParams } = new URL(request.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  if (!orgSlug || !workspaceSlug) {
    return Response.json(
      { error: "orgSlug and workspaceSlug are required" },
      { status: 400, headers: NO_STORE_HEADERS }
    )
  }

  // getWorkspace filters on `members: { some: { userId } }`, so a non-member
  // gets null and is reported identically to a missing workspace — no existence
  // leak across tenants.
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) {
    return Response.json({ error: "Workspace not found" }, { status: 404, headers: NO_STORE_HEADERS })
  }

  try {
    const data = await handler({ userId: session.user.id, workspaceId: workspace.id })
    return Response.json(data ?? { ok: true }, { headers: NO_STORE_HEADERS })
  } catch (error) {
    if (error instanceof CardSortError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: CARD_SORT_ERROR_STATUS[error.code], headers: NO_STORE_HEADERS }
      )
    }
    throw error
  }
}
