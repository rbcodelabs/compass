/**
 * The proxy hop that keeps third-party tokens out of the microVM (ADR-0018).
 *
 * The sandbox is configured with a **Compass** URL per connector and its own
 * short-lived `AGENT_TURN` bearer. Compass swaps that for the user's third-party
 * access token and forwards the MCP request. The sandbox never holds a v0 token,
 * so a prompt-injected agent that exfiltrates every environment variable it can
 * read still leaks nothing that works against v0 after the turn ends.
 *
 * That property only holds if the swap is total, which is what the two
 * allowlists below are for. A pass-through of "everything except Authorization"
 * fails open the moment a new header appears: Vercel adds `x-vercel-*`
 * identifiers, the SDK may add its own, and a cookie header would hand the
 * user's Compass session to the third party. So both directions are **closed
 * lists** — a header not named here does not travel.
 */

/**
 * Request headers forwarded to the third-party MCP server.
 *
 * Everything the MCP streamable-HTTP transport actually needs, and nothing else:
 *
 *  - `content-type` / `accept` — the transport negotiates JSON vs. SSE here.
 *  - `mcp-session-id` — the server's own session handle, opaque to Compass.
 *  - `mcp-protocol-version` — version negotiation.
 *  - `last-event-id` — SSE resumption after a dropped stream.
 *
 * Deliberately absent: `authorization` (replaced), `cookie` (would hand the
 * user's Compass session to a third party), `x-forwarded-*` and `x-vercel-*`
 * (infrastructure detail about Compass, and `x-vercel-protection-bypass` is a
 * live secret on this project), and `user-agent`/`referer` (fingerprinting with
 * no protocol purpose).
 */
export const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]

/**
 * Response headers returned to the sandbox.
 *
 * `www-authenticate` is **deliberately not** forwarded. Re-emitting the
 * provider's challenge would invite the agent SDK to run its own OAuth
 * discovery against Compass's gateway path, which is not an authorization
 * server for the third party's resource — the client would chase a flow that
 * cannot complete. A grant that cannot be refreshed is reported as a plain
 * upstream failure instead, and the fix is for the *user* to reconnect.
 *
 * `set-cookie` is not forwarded either: a third party has no business setting a
 * cookie on a Compass origin.
 */
export const FORWARDED_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
]

/**
 * Caps the JSON-RPC request body Compass will buffer.
 *
 * Buffering is not optional: a 401 from the provider is retried once after a
 * token refresh, and replaying the request needs the body a second time, which a
 * consumed stream cannot give. 1 MiB is far above any real `tools/call`
 * arguments payload while still bounding a hostile one.
 */
export const MAX_GATEWAY_REQUEST_BYTES = 1024 * 1024

/**
 * How long a single proxied MCP call may take.
 *
 * Sits just inside the route's own `maxDuration = 60`, so a slow provider
 * produces a legible `GATEWAY_TIMEOUT` rather than the function being killed
 * mid-flight with no response at all. That is the whole reason for the constant.
 *
 * **There is no platform 60 s cut forcing this number.** An earlier revision of
 * this comment claimed Vercel cuts at 60 s "regardless of `maxDuration`", and
 * that is the old Hobby-plan limit, not this project's: the team is Enterprise
 * with fluid compute, where the default is 300 s and the standard maximum 800 s.
 * Raising both `maxDuration` and this constant is therefore *available* — it was
 * considered and deliberately declined, because a Vercel function held open for
 * minutes waiting on a third party is an expensive way to poll, and the agent
 * ends up blocked on one tool call either way. Providers that expose an
 * asynchronous mode get steered onto it instead, via `agentGuidance` on the
 * connector definition.
 *
 * The consequence still worth stating plainly: an SSE stream held open longer
 * than this is cut. A provider whose only interface is a single long blocking
 * call remains out of reach through this transport.
 */
export const GATEWAY_TIMEOUT_MS = 55_000

export function pickHeaders(source: Headers, allowed: readonly string[]): Headers {
  const picked = new Headers()
  for (const name of allowed) {
    const value = source.get(name)
    if (value !== null) picked.set(name, value)
  }
  return picked
}

/** How much of a provider's error body CloudWatch gets. Enough for a Google error, far short of a document. */
export const UPSTREAM_ERROR_LOG_CHARS = 500

/**
 * Makes a provider response excerpt safe to log: known credential shapes are
 * replaced, `secrets` (the live bearer, refreshed or not) are removed wherever
 * they appear, whitespace is collapsed and the result is cut to
 * {@link UPSTREAM_ERROR_LOG_CHARS}. Redaction runs on the whole text before the
 * cut so a token straddling the limit cannot survive as a prefix.
 */
export function redactUpstreamExcerpt(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]")
  out = out
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/\s+/g, " ")
    .trim()
  return out.slice(0, UPSTREAM_ERROR_LOG_CHARS)
}

/** The JSON-RPC `method` of a request body (`tools/list`), or null when it is not one. */
export function jsonRpcMethodOf(body: ArrayBuffer | undefined): string | null {
  if (!body || body.byteLength === 0 || body.byteLength > 64 * 1024) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    const method = Array.isArray(parsed) ? (parsed[0] as { method?: unknown } | undefined)?.method : (parsed as { method?: unknown }).method
    return typeof method === "string" ? method.slice(0, 64) : null
  } catch {
    return null
  }
}

/** The tool a `tools/call` request names (`params.name`), or null for any other request. */
export function toolNameOf(body: ArrayBuffer | undefined): string | null {
  if (!body || body.byteLength === 0 || body.byteLength > 64 * 1024) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { method?: unknown; params?: { name?: unknown } } | undefined
    const name = first?.method === "tools/call" ? first.params?.name : undefined
    return typeof name === "string" ? name.slice(0, 128) : null
  } catch {
    return null
  }
}

/**
 * How much of a successful response is read looking for an error. A tool error is a
 * sentence; a result bigger than this is a document, not an error, and is skipped.
 */
export const UPSTREAM_RESULT_SCAN_BYTES = 16 * 1024

type JsonRpcMessage = {
  error?: { code?: unknown; message?: unknown }
  result?: { isError?: unknown; content?: unknown }
}

function errorTextOfMessage(message: JsonRpcMessage | null | undefined): string | null {
  if (!message || typeof message !== "object") return null
  if (message.error && typeof message.error === "object") {
    const text = typeof message.error.message === "string" ? message.error.message : "(no message)"
    return typeof message.error.code === "number" ? `[${message.error.code}] ${text}` : text
  }
  if (message.result?.isError === true) {
    const content = Array.isArray(message.result.content) ? message.result.content : []
    const text = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .filter(Boolean)
      .join(" ")
    return text || "(tool error with no text)"
  }
  return null
}

/**
 * The error text carried by a *successful* HTTP response, or null when there is none.
 *
 * Google's Drive MCP server reports a tool failure ("The caller does not have
 * permission") as `{result:{isError:true,content:[{text}]}}` inside a 200, which the
 * non-2xx log cannot see. Handles a plain JSON body, a batch, and an SSE stream
 * (`data:` lines). Text that is not complete JSON-RPC (a truncated or non-JSON
 * body) yields null rather than a guess.
 */
export function toolErrorTextOf(raw: string): string | null {
  const payloads: string[] = []
  const trimmed = raw.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) payloads.push(trimmed)
  else for (const line of raw.split(/\r?\n/)) if (line.startsWith("data:")) payloads.push(line.slice(5).trim())
  for (const payload of payloads) {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      continue
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const text = errorTextOfMessage(message as JsonRpcMessage)
      if (text !== null) return text
    }
  }
  return null
}
