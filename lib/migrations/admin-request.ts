/**
 * Strict parsing of POST /api/admin/migrate bodies.
 *
 * The only lenient case is a genuinely EMPTY body (no body at all, or `{}`): that is the legitimate untargeted
 * apply-pending flow used by ops and the preview tooling. Everything else is strict, because the runner treats a missing
 * `script` as POST-all, so any malformed request that lands there by accident would run migrations the caller never named:
 *   - non-parseable JSON                          -> 400
 *   - JSON that is not an object (array, string, number, boolean, null) -> 400
 *   - any key other than `action` / `script`      -> 400 (a typo like "scrpt" must not become POST-all)
 *   - `action` together with `script`             -> 400
 *   - `action` other than "backfill-workspace-id" -> 400
 *   - `script` that is not a non-empty string     -> 400 (123, [], "", null, {}, true)
 *
 * The vercel-managed pilot path has its own stricter body contract and is handled before this code is reached.
 */
export const BACKFILL_WORKSPACE_ID_ACTION = "backfill-workspace-id"
const ALLOWED_KEYS = new Set(["action", "script"])

export type MigratePostRequest =
  | { ok: true; kind: "apply"; script?: string }
  | { ok: true; kind: "backfill-workspace-id" }
  | { ok: false; error: string }

export function parseMigratePostBody(text: string): MigratePostRequest {
  if (text.trim() === "") return { ok: true, kind: "apply" }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: "Request body is not valid JSON." }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object such as {\"script\":\"<migration name>\"}." }
  }
  const body = raw as Record<string, unknown>
  const keys = Object.keys(body)
  const unknown = keys.filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length) return { ok: false, error: `Unknown field${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => JSON.stringify(k)).join(", ")}. Allowed: "script" or "action".` }
  if (keys.length === 0) return { ok: true, kind: "apply" }
  if ("action" in body) {
    if ("script" in body) return { ok: false, error: 'Send either "action" or "script", not both.' }
    if (body.action !== BACKFILL_WORKSPACE_ID_ACTION) return { ok: false, error: `Unknown action. The only supported action is "${BACKFILL_WORKSPACE_ID_ACTION}".` }
    return { ok: true, kind: "backfill-workspace-id" }
  }
  if (typeof body.script !== "string" || body.script === "") return { ok: false, error: '"script" must be a non-empty string naming one registered migration.' }
  return { ok: true, kind: "apply", script: body.script }
}
