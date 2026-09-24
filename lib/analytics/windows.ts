import { z } from "zod"
import { AnalyticsError, DAY_MS, validateWindow, windowSchema, type MetricWindow } from "./providers"

export const rollingWindowSchema = z.object({ version: z.literal(1), mode: z.literal("rolling"), days: z.union([z.literal(7), z.literal(30), z.literal(90)]) }).strict()
export const followupPolicySchema = z.union([windowSchema, rollingWindowSchema])
export type RollingWindow = z.infer<typeof rollingWindowSchema>
export type FollowupPolicy = z.infer<typeof followupPolicySchema>
export type BindingWindows = { mode: "tracking"; baseline: null; followup: RollingWindow } | { mode: "comparison"; baseline: MetricWindow; followup: MetricWindow }

export function resolveFollowupWindow(policy: FollowupPolicy, now = new Date()): MetricWindow {
  if (!("mode" in policy)) return policy
  const endExclusive = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return { since: new Date(endExclusive - policy.days * DAY_MS).toISOString().slice(0, 10), until: new Date(endExclusive - DAY_MS).toISOString().slice(0, 10) }
}

/** One decoder for legacy persisted windows and new versioned tracking policies. */
export function decodeBindingWindows(baseline: unknown, followup: unknown): BindingWindows {
  if (baseline == null && followup === undefined) return { mode: "tracking", baseline: null, followup: { version: 1, mode: "rolling", days: 30 } }
  const rolling = rollingWindowSchema.safeParse(followup)
  if (baseline == null && rolling.success) return { mode: "tracking", baseline: null, followup: rolling.data }
  const before = windowSchema.safeParse(baseline), after = windowSchema.safeParse(followup)
  if (!before.success || !after.success) throw new AnalyticsError("INVALID_WINDOW")
  validateWindow(before.data); validateWindow(after.data)
  return { mode: "comparison", baseline: before.data, followup: after.data }
}
