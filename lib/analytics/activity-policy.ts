export type ActivityLayer = "discovery" | "delivery" | "learning"
export function safeBrowserPageUrl(input: string, referrer: string, attribution: string | null, hasFlags: boolean): string | null {
  // The hosted collector adds these independently of the SDK's beforeSend URL.
  return referrer || attribution !== null || hasFlags ? null : sanitizedPageUrl(input)
}
export function analyticsCollectionEnabled(environment: string | undefined, epoch: string | undefined, previewAutomation: string | undefined, now = Date.now()): boolean {
  return environment === "production" && previewAutomation !== "1" && Boolean(epoch) && Number.isFinite(Date.parse(epoch!)) && Date.parse(epoch!) <= now
}
export const ACTIVITY_ACTIONS = ["opportunity_created", "opportunity_updated", "solution_created", "solution_updated", "roadmap_created", "roadmap_updated", "experiment_created", "experiment_started", "experiment_concluded", "experiment_updated", "result_recorded", "checkin_recorded"] as const
export type ActivityAction = typeof ACTIVITY_ACTIONS[number]
export function activityAction(model: string, operation: string, after: Record<string, unknown>, before: Record<string, unknown> | null = null): ActivityAction {
  if (model === "experimentResult") return "result_recorded"
  if (model === "checkIn") return "checkin_recorded"
  if (model === "experiment" && operation !== "create") {
    if (!before || before.status === after.status) return "experiment_updated"
    return after.status === "RUNNING" ? "experiment_started" : ["COMPLETE", "KILLED", "NOT_PURSUED"].includes(String(after.status)) ? "experiment_concluded" : "experiment_updated"
  }
  const prefix = model === "roadmapItem" ? "roadmap" : model
  return `${prefix}_${operation === "create" ? "created" : "updated"}` as ActivityAction
}
export const ACTIVITY_FIELDS: Record<string, { layer: ActivityLayer; fields: string[] }> = {
  opportunity: { layer: "discovery", fields: ["title", "description", "customerSegment", "status"] },
  solution: { layer: "discovery", fields: ["title", "description", "status"] },
  roadmapItem: { layer: "delivery", fields: ["horizon", "solutionId", "opportunityId", "keyResultId", "experimentId"] },
  experiment: { layer: "learning", fields: ["status", "conclusion", "conclusionReason"] },
  experimentResult: { layer: "learning", fields: [] },
  checkIn: { layer: "learning", fields: [] },
}
export function classifyActivity(model: string, operation: string, before: Record<string, unknown> | null, after: Record<string, unknown>): ActivityLayer | null {
  const rule = ACTIVITY_FIELDS[model]
  if (!rule) return null
  if (operation === "create") return rule.layer
  if (!["update", "updateMany"].includes(operation) || !before) return null
  return rule.fields.some(field => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) ? rule.layer : null
}

/** Allowlisted route templates only; never emit tenant/entity identifiers. */
export function sanitizedPageUrl(input: string): string | null {
  let url: URL
  try { url = new URL(input) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  const parts = url.pathname.split("/").filter(Boolean)
  if (["api", "auth", "login", "logout", "oauth", "research", "portal", "participate", "_next", "_vercel"].includes(parts[0])) return null
  const sections = ["discovery", "roadmap", "experiments", "okrs", "tasks", "docs", "feedback", "settings"]
  if (parts.length < 3 || parts.length > 4 || !sections.includes(parts[2])) return null
  if (parts.length === 4 && parts[2] === "settings") return null
  return `${url.origin}/:org/:workspace/${parts[2]}${parts.length === 4 ? "/:id" : ""}`
}
