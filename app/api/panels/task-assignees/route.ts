import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkspace } from "@/lib/workspace";
import { eligibleTaskAssignees } from "@/lib/task-assignment";

/**
 * Eligible task assignees (people plus agents) for the assignee pickers.
 *
 * A GET route handler rather than a server action on purpose: server actions
 * are serialized through the Next router's action queue, and a navigation
 * that preempts one can let a queued action commit the pre-navigation URL,
 * reopening the task panel the user just left. See
 * app/api/analytics/measurements/route.ts for the full explanation.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const orgSlug = params.get("orgSlug");
  const workspaceSlug = params.get("workspaceSlug");
  if (!orgSlug || !workspaceSlug) {
    return NextResponse.json({ error: "Missing orgSlug or workspaceSlug" }, { status: 400 });
  }

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id);
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ data: await eligibleTaskAssignees(workspace.id) });
}
