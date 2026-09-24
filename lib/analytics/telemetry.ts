import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { ACTIVITY_ACTIONS } from "./activity-policy"

export const TELEMETRY_PATH = "/api/analytics/activity"
export const activityEventSchema = z.object({ action: z.enum(ACTIVITY_ACTIONS), source: z.enum(["ui", "mcp", "agent"]) }).strict()
type ActivityEvent = z.infer<typeof activityEventSchema>
function relayKey() {
  const value = process.env.ANALYTICS_SECRET_ENCRYPTION_KEY
  if (!value) return null
  const key = Buffer.from(value, "base64")
  return key.length === 32 ? key : null
}
export function telemetrySignature(body: string, timestamp: string): string | null {
  const key = relayKey()
  return key ? createHmac("sha256", key).update("compass-activity-relay-v1\n" + timestamp + "\n" + body).digest("hex") : null
}
export function verifyTelemetry(body: string, timestamp: string | null, signature: string | null, now = Date.now()) {
  if (process.env.VERCEL_ENV !== "production" || process.env.PREVIEW_AUTOMATION_ENABLED === "1") return false
  if (!timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = telemetrySignature(body, timestamp)
  return expected !== null && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))
}
export function telemetryOrigin() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || !host.includes(".") || host.includes("..")) return null
  return `https://${host}`
}
export async function sendActivityEvent(event: ActivityEvent) {
  if (process.env.VERCEL_ENV !== "production" || process.env.PREVIEW_AUTOMATION_ENABLED === "1") return
  const origin = telemetryOrigin()
  const body = JSON.stringify(activityEventSchema.parse(event))
  const timestamp = String(Date.now())
  const signature = telemetrySignature(body, timestamp)
  if (!origin || !signature) return
  // Never forward request headers, host, URL, cookies, user or workspace IDs.
  try { await fetch(origin + TELEMETRY_PATH, { method: "POST", headers: { "content-type": "application/json", "x-activity-timestamp": timestamp, "x-activity-signature": signature }, body, redirect: "error", signal: AbortSignal.timeout(3000) }) } catch { /* best-effort telemetry, not product state */ }
}
