import { z } from "zod"
import { AnalyticsError } from "./providers"

const safeCodes = new Set([
  "DISCONNECTED", "CONNECTION_CHANGED", "PROVIDER_UNAVAILABLE", "RATE_LIMITED", "DATA_UNAVAILABLE", "INVALID_WINDOW",
  "AUTHENTICATION", "ACCESS_DENIED", "PROJECT_NOT_FOUND", "ANALYTICS_DISABLED", "PLAN_REQUIRED", "PROJECT_IDENTITY_IMMUTABLE",
  "REVISION_CONFLICT", "ENCRYPTION_NOT_CONFIGURED", "BINDING_INACTIVE", "METRIC_ARCHIVED", "NOT_FOUND_OR_ACCESS_DENIED",
  "HUMAN_ADMIN_REQUIRED", "OPERATOR_ONLY", "PRODUCTION_ONLY", "ACTIVATION_NOT_CONFIGURED", "ACTIVATION_WINDOW", "UNSUPPORTED_QUERY", "TOO_MANY_FILTERS",
])
export type AnalyticsActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Only explicit public codes cross the server-action boundary, never exception text. */
export async function analyticsAction<T>(operation: () => Promise<T>): Promise<AnalyticsActionResult<T>> {
  try { return { ok: true, data: await operation() } }
  catch (error) {
    return { ok: false, error: error instanceof AnalyticsError && safeCodes.has(error.code) ? error.code : error instanceof z.ZodError ? "INVALID_INPUT" : "CHANGE_FAILED" }
  }
}

export function unwrapAnalyticsAction<T>(result: AnalyticsActionResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}
