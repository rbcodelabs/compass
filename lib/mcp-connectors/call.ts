/**
 * Server-side MCP tool calls made *on behalf of a signed-in user* using their
 * connector grant (ADR-0018).
 *
 * The gateway route (`app/api/integrations/mcp/[slug]/route.ts`) proxies the
 * cloud agent's traffic. This module is the other consumer of the same grant:
 * Compass itself calling a connector, e.g. to refresh a v0 chat Artifact. It
 * keeps the gateway's safety properties:
 *
 *  - the token comes from `resolveConnectorToken` for the *caller's* user id and
 *    never from anything in a request;
 *  - the endpoint is re-checked as HTTPS and redirects are never followed, since
 *    every request carries a live third-party bearer;
 *  - a 401 is retried exactly once, after a refresh;
 *  - every call is bounded by a timeout.
 *
 * Transport: MCP streamable HTTP. `initialize` → `notifications/initialized` →
 * `tools/call`. A server may answer with `application/json` or a short-lived
 * `text/event-stream`; both are accepted.
 */

import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { McpConnectorError, connectorDefinition } from "@/lib/mcp-connectors/config"
import { requireHttpsUrl } from "@/lib/mcp-connectors/http"
import { mcpConnectorsAvailable } from "@/lib/mcp-connectors/store"
import { refreshConnectorToken, resolveConnectorToken } from "@/lib/mcp-connectors/tokens"

export const CONNECTOR_CALL_TIMEOUT_MS = 30_000
const MAX_CALL_RESPONSE_BYTES = 4 * 1024 * 1024
const PROTOCOL_VERSION = "2025-03-26"

export interface ConnectorToolResult {
  /** `structuredContent` when the server sent it; otherwise the first text block parsed as JSON, if it parses. */
  structured: unknown
  /** Concatenated text content blocks. */
  text: string
}

class UpstreamUnauthorized extends Error {}

interface RpcReply {
  status: number
  sessionId: string | null
  message: Record<string, unknown> | null
}

export async function callConnectorTool(input: {
  slug: string
  userId: string
  toolName: string
  args: Record<string, unknown>
}): Promise<ConnectorToolResult> {
  const message = await connectorRequest(input.slug, input.userId, "tools/call", { name: input.toolName, arguments: input.args })
  return parseToolResult(message, input.toolName)
}

/** Names of the tools the caller's connector server currently offers (`tools/list`). */
export async function listConnectorToolNames(input: { slug: string; userId: string }): Promise<string[]> {
  const message = await connectorRequest(input.slug, input.userId, "tools/list", {})
  if (message?.error) throw new McpConnectorError("GATEWAY_FAILED", `tools/list failed: ${describeRpcError(message.error)}`)
  const tools = (message?.result as { tools?: unknown } | undefined)?.tools
  return Array.isArray(tools) ? tools.map((t) => (t as { name?: unknown })?.name).filter((n): n is string => typeof n === "string") : []
}

async function connectorRequest(slug: string, userId: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const input = { slug, userId, method, params }
  const definition = connectorDefinition(input.slug)
  if (!definition) throw new McpConnectorError("UNKNOWN_CONNECTOR", `Unknown connector "${input.slug}".`)
  if (!(await mcpConnectorsAvailable()))
    throw new McpConnectorError("NOT_CONNECTED", "Connectors are not available on this deployment.")

  const resolved = await resolveConnectorToken(input.slug, trustedCompassBaseUrl().origin, input.userId)
  if (!resolved)
    throw new McpConnectorError(
      "NOT_CONNECTED",
      `You have not connected ${definition.displayName} to Compass. Connect it in Settings → My agents, then try again.`,
    )

  try {
    return await session(resolved.connector.serverUrl, resolved.accessToken, input.method, input.params)
  } catch (error) {
    if (!(error instanceof UpstreamUnauthorized)) throw error
    const refreshed = await refreshConnectorToken(resolved, input.userId)
    if (!refreshed) throw new McpConnectorError("NOT_CONNECTED", "This connection was removed. Reconnect it in Settings → My agents.")
    try {
      return await session(resolved.connector.serverUrl, refreshed, input.method, input.params)
    } catch (second) {
      if (second instanceof UpstreamUnauthorized)
        throw new McpConnectorError(
          "REFRESH_FAILED",
          `${definition.displayName} rejected a freshly refreshed token. Reconnect it in Settings → My agents.`,
        )
      throw second
    }
  }
}

async function session(serverUrl: string, token: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const target = requireHttpsUrl(serverUrl, "serverUrl", "GATEWAY_FAILED")
  const signal = AbortSignal.timeout(CONNECTOR_CALL_TIMEOUT_MS)
  const init = await rpc(target, token, null, signal, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "compass", version: "1.0.0" } },
  })
  if (init.message?.error) throw new McpConnectorError("GATEWAY_FAILED", `initialize failed: ${describeRpcError(init.message.error)}`)
  const sessionId = init.sessionId
  try {
    await rpc(target, token, sessionId, signal, { jsonrpc: "2.0", method: "notifications/initialized" }, false)
    const reply = await rpc(target, token, sessionId, signal, {
      jsonrpc: "2.0",
      id: 2,
      method,
      params,
    })
    return reply.message
  } finally {
    if (sessionId) {
      // Best effort; the session is disposable and the call already has its answer.
      void fetch(target, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "mcp-session-id": sessionId },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
    }
  }
}

async function rpc(
  target: URL,
  token: string,
  sessionId: string | null,
  signal: AbortSignal,
  payload: Record<string, unknown>,
  expectReply = true,
): Promise<RpcReply> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  }
  if (sessionId) headers["mcp-session-id"] = sessionId

  let response: Response
  try {
    response = await fetch(target, { method: "POST", headers, body: JSON.stringify(payload), redirect: "manual", cache: "no-store", signal })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new McpConnectorError("GATEWAY_TIMEOUT", `${target.origin} did not answer within ${CONNECTOR_CALL_TIMEOUT_MS} ms.`)
    throw new McpConnectorError("GATEWAY_FAILED", `${target.origin} did not answer: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    throw new UpstreamUnauthorized()
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {})
    throw new McpConnectorError("GATEWAY_FAILED", `${target.origin} redirected (${response.status}); redirects are not followed while carrying a bearer token.`)
  }
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId
  if (!expectReply) {
    await response.body?.cancel().catch(() => {})
    if (response.status >= 400) throw new McpConnectorError("GATEWAY_FAILED", `${target.origin} returned ${response.status}.`)
    return { status: response.status, sessionId: nextSession, message: null }
  }
  let text: string
  try {
    text = await readBounded(response)
  } catch (error) {
    if (error instanceof McpConnectorError) throw error
    if (error instanceof Error && error.name === "TimeoutError")
      throw new McpConnectorError("GATEWAY_TIMEOUT", `${target.origin} did not finish answering within ${CONNECTOR_CALL_TIMEOUT_MS} ms.`)
    throw new McpConnectorError("GATEWAY_FAILED", `Reading the ${target.origin} response failed.`)
  }
  if (response.status >= 400) throw new McpConnectorError("GATEWAY_FAILED", `${target.origin} returned ${response.status}: ${text.slice(0, 200)}`)
  const message = parseRpcBody(text, response.headers.get("content-type") ?? "", payload.id)
  return { status: response.status, sessionId: nextSession, message }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_CALL_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new McpConnectorError("GATEWAY_FAILED", "The connector response was too large.")
    }
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

/** Extracts the JSON-RPC message answering `id` from a JSON or SSE body. Exported for tests. */
export function parseRpcBody(body: string, contentType: string, id: unknown): Record<string, unknown> | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  const candidates: unknown[] = []
  if (contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
      if (!data) continue
      try { candidates.push(JSON.parse(data)) } catch { /* skip non-JSON events */ }
    }
  } else {
    try { candidates.push(JSON.parse(trimmed)) } catch { throw new McpConnectorError("GATEWAY_FAILED", "The connector returned a response that is not JSON.") }
  }
  const messages = candidates.flatMap((c) => (Array.isArray(c) ? c : [c])).filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
  return messages.find((m) => m.id === id && ("result" in m || "error" in m)) ?? null
}

function describeRpcError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") return (error as { message: string }).message.slice(0, 300)
  return "unknown error"
}

/** Exported for tests. */
export function parseToolResult(message: Record<string, unknown> | null, toolName: string): ConnectorToolResult {
  if (!message) throw new McpConnectorError("GATEWAY_FAILED", `The connector sent no reply to ${toolName}.`)
  if (message.error) throw new McpConnectorError("GATEWAY_FAILED", `${toolName} failed: ${describeRpcError(message.error)}`)
  const result = message.result as { content?: unknown; structuredContent?: unknown; isError?: unknown } | undefined
  const blocks = Array.isArray(result?.content) ? (result.content as Array<{ type?: string; text?: string }>) : []
  const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n")
  if (result?.isError) throw new McpConnectorError("GATEWAY_FAILED", `${toolName} reported an error: ${text.slice(0, 300) || "no detail"}`)
  let structured: unknown = result?.structuredContent
  if (structured === undefined && text) {
    try { structured = JSON.parse(text) } catch { structured = undefined }
  }
  return { structured, text }
}
