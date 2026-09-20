export type McpPayload = {
  jsonrpc?: string
  id?: unknown
  result?: {
    isError?: boolean
    content?: Array<{ type?: string; text?: string }>
    structuredContent?: unknown
  }
  error?: { code?: number; message?: string }
}

export type McpToolEnvelope = {
  ok: boolean
  message: string
  data: unknown
}

export function probeOpportunityFixture(id: string, workspaceId: string, nonce: string) {
  return {
    id,
    workspaceId,
    title: `OAuth probe opportunity ${nonce}`,
    description: "Synthetic row proving the agent can read its granted workspace.",
    source: "MCP" as const,
  }
}

export function mcpEnvelopeContainsItemId(
  envelope: McpToolEnvelope | null,
  expectedId: string,
): boolean {
  if (!envelope?.ok || !envelope.data || typeof envelope.data !== "object") return false
  const items = (envelope.data as { items?: unknown }).items
  return Array.isArray(items) && items.some(
    (item) => Boolean(item && typeof item === "object" && (item as { id?: unknown }).id === expectedId),
  )
}

function isPayload(value: unknown): value is McpPayload {
  return Boolean(value && typeof value === "object" && "jsonrpc" in value)
}

/** Parse either JSON or the JSON-RPC `data:` event from Streamable HTTP. */
export function parseMcpPayload(body: string): McpPayload {
  try {
    const parsed = JSON.parse(body) as unknown
    if (isPayload(parsed)) return parsed
  } catch {
    // Streamable HTTP commonly returns SSE rather than a JSON document.
  }

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as unknown
      if (isPayload(parsed)) return parsed
    } catch {
      // Ignore keepalive/non-JSON events and keep looking for the response.
    }
  }
  // Never include `body`: a broken server could reflect an Authorization value.
  throw new Error("MCP response contained no JSON-RPC payload")
}

export function mcpToolEnvelope(payload: McpPayload): McpToolEnvelope | null {
  const candidate = payload.result?.structuredContent
  if (!candidate || typeof candidate !== "object") return null
  const record = candidate as Record<string, unknown>
  if (typeof record.ok !== "boolean" || typeof record.message !== "string") return null
  return { ok: record.ok, message: record.message, data: record.data }
}

export function mcpErrorText(payload: McpPayload): string | null {
  if (typeof payload.error?.message === "string") return payload.error.message
  const text = payload.result?.content?.find(
    (block) => block.type === "text" && typeof block.text === "string",
  )?.text
  return text ?? null
}

/** Run registered cleanups LIFO, attempting all of them without masking work errors. */
export async function runCleanupStack(
  cleanups: ReadonlyArray<() => Promise<void>>,
): Promise<unknown[]> {
  const failures: unknown[] = []
  for (let index = cleanups.length - 1; index >= 0; index -= 1) {
    try {
      await cleanups[index]()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}
