import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { CardSortError } from "@/lib/card-sort";
import { computeChangeToken, computeEntityChangeToken, isLiveScope, parseEntityScope } from "@/lib/live-change-token";

/**
 * Change token for live board refresh (see lib/live-change-token.ts).
 *
 * A GET route handler rather than a server action on purpose: this is polled
 * every few seconds, and server actions are serialized through the Next router
 * action queue, where a poll would delay or reorder real user mutations. Same
 * reasoning as app/api/panels/task-assignees/route.ts.
 *
 * Authorization matches the pages the token feeds: the caller must be able to
 * read the workspace (getWorkspace also resolves the org-wide read-only
 * fallback). The token is a hash, so it exposes no row content.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const orgSlug = params.get("orgSlug");
  const workspaceSlug = params.get("workspaceSlug");
  const scope = params.get("scope");
  if (!orgSlug || !workspaceSlug) {
    return NextResponse.json({ error: "Missing orgSlug or workspaceSlug" }, { status: 400 });
  }
  const entity = parseEntityScope(scope);
  if (!entity && !isLiveScope(scope)) return NextResponse.json({ error: "Unknown scope" }, { status: 400 });

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (entity) {
    // null = the entity is not in this workspace; indistinguishable from absent.
    const entityToken = await computeEntityChangeToken(entity, workspace.id);
    if (entityToken === null) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ token: entityToken }, { headers: { "Cache-Control": "no-store" } });
  }
  if (!isLiveScope(scope)) return NextResponse.json({ error: "Unknown scope" }, { status: 400 });

  const roundId = params.get("roundId");
  if (scope === "cardSort" && !roundId) {
    return NextResponse.json({ error: "Missing roundId" }, { status: 400 });
  }

  let token: string;
  try {
    token = await computeChangeToken(scope, workspace.id, { userId: session.user.id, roundId });
  } catch (error) {
    if (error instanceof CardSortError && error.code === "NOT_FOUND") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }
  return NextResponse.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
