import { z } from "zod"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { querySchema, windowSchema, AnalyticsError } from "./providers"
import { followupPolicySchema } from "./windows"
import * as service from "./service"

const workspace = { workspaceId: z.string().uuid() }
const metricId = { ...workspace, metricId: z.string().uuid() }
const bindingId = { ...workspace, bindingId: z.string().uuid() }
const observationId = { ...workspace, observationId: z.string().uuid() }
const definition = {
  name: z.string().trim().min(1).max(120), unit: z.string().trim().min(1).max(40),
  provider: z.enum(["vercel", "compass_activation"]), connectionId: z.string().uuid().optional(),
  query: querySchema,
}
const target = { targetType: z.enum(["EXPERIMENT", "ROADMAP_ITEM", "KEY_RESULT"]), targetId: z.string().uuid() }
export const analyticsToolSchemas = {
  list_analytics_connections: workspace, list_metrics: workspace, get_metric: metricId,
  create_metric: { ...workspace, ...definition },
  update_metric: { ...metricId, ...definition, expectedRevision: z.number().int().positive() },
  archive_metric: metricId,
  list_metric_bindings: { ...workspace, ...target, includeInactive: z.boolean().optional() },
  get_metric_binding: bindingId,
  link_metric: { ...metricId, ...target, baseline: windowSchema.nullable().optional().describe("Optional comparison baseline. Omit both windows for rolling 30-day tracking."), followup: followupPolicySchema.optional(), target: z.number().finite().optional() },
  update_metric_binding: { ...bindingId, baseline: windowSchema.nullable().optional().describe("Set null with a rolling followup policy to switch to tracking."), followup: followupPolicySchema.optional(), target: z.number().finite().nullable().optional() },
  unlink_metric: bindingId,
  refresh_metric_binding: { ...bindingId, requestId: z.string().uuid().describe("Reuse this UUID when retrying the same refresh.") },
  list_metric_observations: bindingId,
  get_metric_observation: observationId,
}
export type AnalyticsTool = keyof typeof analyticsToolSchemas

/** Schema parsing here also protects built-in agent calls outside the MCP SDK. */
export async function handleAnalyticsTool(name: AnalyticsTool, input: unknown) {
  const args = z.object(analyticsToolSchemas[name]).parse(input)
  const actor = getMcpActor()
  // Each branch is parsed against its exact schema; no caller-supplied credentials.
  const parse = <N extends AnalyticsTool>(tool: N) => z.object(analyticsToolSchemas[tool]).parse(input)
  let data: unknown
  let id: string | undefined
  try {
    switch (name) {
      case "list_analytics_connections": data = await service.listConnections(actor, args.workspaceId); break
      case "list_metrics": data = await service.listMetrics(actor, args.workspaceId); break
      case "get_metric": data = await service.getMetric(actor, args.workspaceId, parse(name).metricId); break
      case "create_metric": { const { workspaceId, ...x } = parse(name); data = await service.createMetric(actor, workspaceId, x); break }
      case "update_metric": { const { workspaceId, metricId, ...x } = parse(name); data = await service.updateMetric(actor, workspaceId, metricId, x); break }
      case "archive_metric": { const x = parse(name); data = await service.archiveMetric(actor, x.workspaceId, x.metricId); id = x.metricId; break }
      case "list_metric_bindings": { const { workspaceId, includeInactive, ...x } = parse(name); data = await service.listBindings(actor, workspaceId, x, { includeInactive }); break }
      case "get_metric_binding": { const x = parse(name); data = await service.getBinding(actor, x.workspaceId, x.bindingId); break }
      case "link_metric": { const { workspaceId, ...x } = parse(name); data = await service.linkMetric(actor, workspaceId, x); break }
      case "update_metric_binding": { const { workspaceId, bindingId, ...x } = parse(name); data = await service.updateBinding(actor, workspaceId, bindingId, x); break }
      case "unlink_metric": { const x = parse(name); data = await service.unlinkMetric(actor, x.workspaceId, x.bindingId); id = x.bindingId; break }
      case "refresh_metric_binding": { const x = parse(name); data = await service.refreshBinding(actor, x.workspaceId, x.bindingId, x.requestId); id = x.bindingId; break }
      case "list_metric_observations": { const x = parse(name); data = await service.listObservations(actor, x.workspaceId, x.bindingId); break }
      case "get_metric_observation": { const x = parse(name); data = await service.getObservation(actor, x.workspaceId, x.observationId); break }
    }
  } catch (error) {
    // Do not echo network errors, credentials or raw provider responses.
    if (error instanceof AnalyticsError) return fail(error.code)
    throw error
  }
  if (data && typeof data === "object" && "id" in data && typeof data.id === "string") id = data.id
  return ok(`${name} completed${id ? `\nID: ${id}` : ""}`, Array.isArray(data) ? { items: data, count: data.length } : data ?? { id })
}
