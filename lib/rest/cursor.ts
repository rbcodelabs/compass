import { createHmac, timingSafeEqual } from "node:crypto"

type CursorPayload = { id: string; createdAt: string; context: string }

function secret(): string {
  const value = process.env.REST_CURSOR_SECRET || process.env.MCP_API_KEY
  if (value) return value
  if (process.env.NODE_ENV !== "production") return "compass-local-rest-cursor"
  throw new Error("REST_CURSOR_SECRET or MCP_API_KEY must be configured.")
}

export function encodeCursor(payload: CursorPayload): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret()).update(data).digest("base64url")
  return `${data}.${signature}`
}

export function decodeCursor(cursor: string, context: string): CursorPayload | null {
  const [data, signature, extra] = cursor.split(".")
  if (!data || !signature || extra) return null
  const expected = createHmac("sha256", secret()).update(data).digest()
  let supplied: Buffer
  try { supplied = Buffer.from(signature, "base64url") } catch { return null }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as CursorPayload
    if (payload.context !== context || !payload.id || Number.isNaN(new Date(payload.createdAt).getTime())) return null
    return payload
  } catch { return null }
}
