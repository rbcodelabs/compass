import * as analytics from "@/lib/analytics/service"
import { analyticsReadContext, json } from "@/lib/analytics/read-route"

export async function GET(request: Request) {
  const context = await analyticsReadContext(request)
  if (!context.ok) return context.response
  try {
    return json(await analytics.listMetrics(context.actor, context.workspaceId))
  } catch {
    return json({ error: "Metrics could not be loaded" }, 500)
  }
}
