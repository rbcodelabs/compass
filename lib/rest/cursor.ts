import { createHmac, timingSafeEqual } from "node:crypto"

type CursorPayload = { id: string; createdAt: string; context: string }
export type OrderedCursorPayload = { id: string; objectType: string; order: number; context: string }

function secret(): string {
  const value = process.env.REST_CURSOR_SECRET || process.env.MCP_API_KEY
  if (value) return value
  if (process.env.NODE_ENV !== "production") return "compass-local-rest-cursor"
  throw new Error("REST_CURSOR_SECRET or MCP_API_KEY must be configured.")
}

export function encodeCursor(payload: CursorPayload): string {
  return encodeSignedCursor(payload)
}

export function encodeOrderedCursor(payload: OrderedCursorPayload): string {
  return encodeSignedCursor(payload)
}

function encodeSignedCursor(payload: CursorPayload | OrderedCursorPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret()).update(data).digest("base64url")
  return `${data}.${signature}`
}

export function decodeCursor(cursor: string, context: string): CursorPayload | null {
  const payload = decodeSignedCursor(cursor)
  if (!payload || payload.context !== context || typeof payload.id !== "string" || !payload.id || typeof payload.createdAt !== "string" || Number.isNaN(new Date(payload.createdAt).getTime())) return null
  return payload as CursorPayload
}

export function decodeOrderedCursor(cursor: string, context: string): OrderedCursorPayload | null {
  const payload = decodeSignedCursor(cursor)
  if (!payload || payload.context !== context || typeof payload.id !== "string" || !payload.id || typeof payload.objectType !== "string" || !payload.objectType || typeof payload.order !== "number" || !Number.isFinite(payload.order)) return null
  return payload as OrderedCursorPayload
}

function decodeSignedCursor(cursor: string): Record<string, unknown> | null {
  const [data, signature, extra] = cursor.split(".")
  if (!data || !signature || extra) return null
  const expected = createHmac("sha256", secret()).update(data).digest()
  let supplied: Buffer
  try { supplied = Buffer.from(signature, "base64url") } catch { return null }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as unknown
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  } catch { return null }
}
