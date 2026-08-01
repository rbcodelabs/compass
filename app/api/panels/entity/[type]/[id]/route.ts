import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { getEntityDetail, isEntityType } from "@/lib/entity-detail";

/**
 * Detail-panel data source for every entity type. GET
 *   /api/panels/entity/<type>/<id>?orgSlug=<>&workspaceSlug=<>
 * returns `{ type, data }` (see lib/entity-detail.ts) for the entity, or a
 * 404 when it doesn't exist *or* isn't in the caller's workspace.
 *
 * Access control is two-layered and both layers are required:
 *   1. Session must exist (signed-in user).
 *   2. The user must be a member of the org/workspace named in the query
 *      params — getWorkspace() only returns a workspace the user belongs to.
 * Only then do we look up the entity, and getEntityDetail additionally scopes
 * the query to that workspace id. This is what closes the cross-workspace
 * IDOR the earlier per-type panel routes had (session-only, no scoping).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ type: string; id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { type, id } = await params;
  if (!isEntityType(type)) {
    return NextResponse.json({ error: "Unknown entity type" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const orgSlug = searchParams.get("orgSlug");
  const workspaceSlug = searchParams.get("workspaceSlug");
  if (!orgSlug || !workspaceSlug) {
    return NextResponse.json(
      { error: "orgSlug and workspaceSlug are required" },
      { status: 400 }
    );
  }

  // Membership check: returns null if the workspace doesn't exist or the user
  // isn't a member — either way the caller has no business reading its data.
  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const detail = await getEntityDetail(type, id, workspace.id);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
