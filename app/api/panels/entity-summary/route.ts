import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { isEntityId, type EntityLinkType } from "@/lib/entity-links";
import { getEntitySummary } from "@/lib/entity-summary";
import { resolveThinkingModel } from "@/lib/thinking-model/resolve";

const SUMMARY_TYPES: ReadonlySet<string> = new Set<EntityLinkType>([
  "objective", "keyResult", "opportunity", "solution", "assumption",
  "experiment", "roadmapItem", "feedback", "task", "doc", "artifact",
]);

/**
 * Link-card data source. GET
 *   /api/panels/entity-summary?orgSlug=&workspaceSlug=&type=&id=
 * returns the thin `EntitySummary` (title, state, one line of context) for the
 * chat's "live card" rendering of a Compass link.
 *
 * Same two-layer access rule as /api/panels/entity: a session is required, and
 * the caller must be a member of the named workspace — getWorkspace() returns
 * null otherwise. The lookup is then scoped to that workspace id, so a link to
 * a foreign workspace's row 404s exactly like a row that does not exist.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const orgSlug = searchParams.get("orgSlug");
  const workspaceSlug = searchParams.get("workspaceSlug");
  const type = searchParams.get("type");
  const id = searchParams.get("id");
  if (!orgSlug || !workspaceSlug || !type || !id) {
    return NextResponse.json({ error: "orgSlug, workspaceSlug, type and id are required" }, { status: 400 });
  }
  if (!SUMMARY_TYPES.has(type)) return NextResponse.json({ error: "Unknown entity type" }, { status: 400 });
  if (!isEntityId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const summary = await getEntitySummary(type as EntityLinkType, id, workspace.id, resolveThinkingModel(workspace).labels);
  if (!summary) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(summary);
}
