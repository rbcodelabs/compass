import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { getEntityDetail, isEntityType } from "@/lib/entity-detail";
import { updateEntityField } from "@/lib/entity-mutations";
import getPrisma from "@/lib/db";
import { resolveWorkItem, type WorkItemResolution } from "@/lib/work-item-resolve";
import { startRunForAssignedTask } from "@/lib/agent-task-trigger";

/** A UUID or a display ID (`TASK-5`) in the URL; anything that does not resolve inside the workspace is the same 404 as before. */
function refusal(resolved: Extract<WorkItemResolution, { ok: false }>) {
  return NextResponse.json({ error: resolved.reason === "not_found" ? "Not found" : resolved.message }, { status: resolved.reason === "not_found" ? 404 : 400 });
}

// An assignee edit can start a cloud agent's run; its sandbox start is deferred with after() and shares this function's budget,
// so give it room rather than the platform default (a function killed mid-start leaves the run QUEUED).
export const maxDuration = 300;

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

  const resolved = await resolveWorkItem(getPrisma(), workspace.id, type, id);
  if (!resolved.ok) return refusal(resolved);

  const detail = await getEntityDetail(type, resolved.id, workspace.id);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ...detail, displayId: resolved.displayId });
}

/**
 * Inline edit from the panel: PATCH …?orgSlug&workspaceSlug with body
 * `{ field, value }`. Same two-layer auth as GET (session + workspace
 * membership); the write itself is workspace-scoped in updateEntityField, so
 * the IDOR boundary applies to edits exactly as it does to reads. Returns the
 * refreshed `{ type, data }` so the client updates in a single round-trip.
 */
export async function PATCH(
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

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Org-wide read-only members can view every entity through GET above but
  // may not edit any of them -- see assertWorkspaceWritable's doc comment in
  // lib/workspace-context.ts. Checked directly rather than via that helper's
  // throw so the response stays a clean 403 JSON body like every other error
  // path in this route, instead of an uncaught exception.
  if (workspace.isReadOnly) {
    return NextResponse.json({ error: "Forbidden: workspace is read-only" }, { status: 403 });
  }

  let body: { field?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.field !== "string") {
    return NextResponse.json({ error: "field is required" }, { status: 400 });
  }

  const resolved = await resolveWorkItem(getPrisma(), workspace.id, type, id);
  if (!resolved.ok) return refusal(resolved);

  // An assignee change on a task can start a cloud agent's run; remember who was assigned before the write.
  const assigneeEdit = type === "task" && body.field === "assignee";
  const previousAssigneeAgentId = assigneeEdit
    ? (await getPrisma().task.findFirst({ where: { id: resolved.id, workspaceId: workspace.id }, select: { assigneeAgentId: true } }))?.assigneeAgentId ?? null
    : null;

  const result = await updateEntityField(
    type,
    resolved.id,
    workspace.id,
    body.field,
    body.value,
    { kind: "USER", id: session.user.id },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const agentRun = assigneeEdit ? await startRunForAssignedTask({ taskId: resolved.id, actingUserId: session.user.id, previousAssigneeAgentId }) : null;

  const detail = await getEntityDetail(type, resolved.id, workspace.id);
  // A solution moving to Building can add it to the roadmap; tell the client so it can offer Undo.
  return NextResponse.json({
    ...detail,
    displayId: resolved.displayId,
    ...(result.roadmapSync ? { roadmapSync: result.roadmapSync } : {}),
    // Only when a run started, was already going, or was refused: the client tells the person (a "skipped" says nothing).
    ...(agentRun && agentRun.status !== "skipped" ? { agentRun } : {}),
  });
}
