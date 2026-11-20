/** Public inspection diagnostics contain only these fixed codes and categories, never driver text or record values. */
const PUBLIC_CODES = {
  ECONNREFUSED: "CONNECTION", ETIMEDOUT: "CONNECTION", ECONNRESET: "CONNECTION", EHOSTUNREACH: "CONNECTION",
  ENETUNREACH: "CONNECTION", ENOTFOUND: "CONNECTION", EAI_AGAIN: "CONNECTION",
  P1001: "CONNECTION", P1002: "CONNECTION", P1017: "CONNECTION", P2024: "CONNECTION",
  P2021: "SCHEMA", "42P01": "SCHEMA", "42501": "PERMISSION", P1010: "PERMISSION",
  "57014": "TIMEOUT", P2028: "TIMEOUT",
} as const

type PublicCode = keyof typeof PUBLIC_CODES
type PublicDiagnostic = { category: (typeof PUBLIC_CODES)[PublicCode]; code: PublicCode } | { category: "UNKNOWN" }
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Inspect only bounded error/code links. Even a throwing getter never escapes as response text. */
export function describeInspectionFailure(error: unknown): PublicDiagnostic {
  const seen = new Set<unknown>()
  const pending: Array<{ error: unknown; depth: number }> = [{ error, depth: 0 }]
  let visited = 0
  while (pending.length && visited++ < 25) {
    const current = pending.shift()!
    if (!isObject(current.error) || seen.has(current.error) || current.depth > 4) continue
    seen.add(current.error)
    try {
      const code = current.error.code
      if (typeof code === "string" && Object.hasOwn(PUBLIC_CODES, code)) {
        return { category: PUBLIC_CODES[code as PublicCode], code: code as PublicCode }
      }
      pending.push({ error: current.error.cause, depth: current.depth + 1 })
      if (Array.isArray(current.error.errors)) {
        for (const member of current.error.errors.slice(0, 5)) pending.push({ error: member, depth: current.depth + 1 })
      }
      const meta = current.error.meta
      if (isObject(meta)) pending.push({ error: meta.driverAdapterError, depth: current.depth + 1 })
    } catch {
      // Unknown/getter failures share the fixed fallback for unknown driver codes.
    }
  }
  return { category: "UNKNOWN" }
}
