import * as analytics from "@/lib/analytics/service"
import { analyticsReadContext, json, readFailure } from "@/lib/analytics/read-route"

export async function GET(request: Request) {
  const context = await analyticsReadContext(request)
  if (!context.ok) return context.response
  const target = analytics.targetSchema.safeParse({
    targetType: context.searchParams.get("targetType"),
    targetId: context.searchParams.get("targetId"),
  })
  if (!target.success) return json({ error: "Invalid target" }, 400)
  try {
    const bindings = await analytics.listBindings(context.actor, context.workspaceId, target.data)
    return json(await Promise.all(bindings.map(async (binding) => ({
      binding,
      observations: await analytics.listObservations(context.actor, context.workspaceId, binding.id),
    }))))
  } catch (error) {
    return readFailure(error, "Measurements could not be loaded")
  }
}
