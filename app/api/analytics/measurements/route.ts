import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import * as analytics from "@/lib/analytics/service"
import { AnalyticsError } from "@/lib/analytics/providers"
import type { McpActor } from "@/lib/mcp-authz"

/**
 * Read-only data for MeasurementsPanel: the target's metric bindings with
 * their observations, plus the workspace metric catalogue.
 *
 * This is deliberately a GET route handler rather than a server action. Every
 * server action is serialized through the Next router's action queue, and in
 * Next 16.2 a navigation that preempts a pending action can start the next
 * queued action against the pre-navigation router state; when it settles, the
 * old URL is committed again. A panel that loaded its data through actions
 * therefore reopened (`?detail=…`) after the user navigated away from it.
 * Plain fetches never enter that queue — the same pattern as
 * /api/panels/entity.
 */
export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const params = new URL(request.url).searchParams
  const orgSlug = params.get("orgSlug")
  const workspaceSlug = params.get("workspaceSlug")
  const target = analytics.targetSchema.safeParse({ targetType: params.get("targetType"), targetId: params.get("targetId") })
  if (!orgSlug || !workspaceSlug || !target.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const actor: McpActor = { userId: session.user.id, purpose: "USER" }
  try {
    const [bindings, metrics] = await Promise.all([
      analytics.listBindings(actor, workspace.id, target.data),
      analytics.listMetrics(actor, workspace.id),
    ])
    const measurements = await Promise.all(bindings.map(async (binding) => ({
      binding,
      observations: await analytics.listObservations(actor, workspace.id, binding.id),
    })))
    return NextResponse.json({ measurements, metrics })
  } catch (error) {
    if (error instanceof AnalyticsError && error.code === "NOT_FOUND_OR_ACCESS_DENIED") {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    return NextResponse.json({ error: "Measurements could not be loaded" }, { status: 500 })
  }
}
