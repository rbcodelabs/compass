// EXPERIMENTAL opencode harness adapter (default off; AGENT_HARNESS=opencode).
//
// Everything that knows opencode's shapes lives in this one file so API drift in
// opencode (or its SDK) is absorbed here and nowhere else:
//
//   - buildOpencodeConfig()   the config handed to `opencode serve` (deny-by-default)
//   - opencodeProcessEnv()    the scrubbed environment the opencode process runs in
//   - OpencodeEventMapper     opencode SSE events  -> the harness-agnostic AGENT_EVENT
//                             shape that lib/agent-run-stream.ts and the audit-row
//                             derivation already consume (Claude Agent SDK message shape)
//   - usageFromMessages()     opencode token/cost accounting -> AGENT_RESULT usage
//
// Pure functions only (no process I/O) so the unit tests can exercise them directly.
// This file is also written into the sandbox next to opencode-turn-entry.ts, so it
// must stay strip-only TypeScript: no enums, namespaces or parameter properties (see
// __tests__/agent-entry-scripts.test.ts). Types come from the SDK as `import type`,
// which Node erases.

import type { Config } from "@opencode-ai/sdk/v2"

/** Pinned: the adapter is written against these exact versions' wire shapes. */
export const OPENCODE_VERSION = "1.19.3"

/** opencode's built-in Vercel AI Gateway provider (npm @ai-sdk/gateway). */
export const GATEWAY_PROVIDER_ID = "vercel"

/** Server keys in the MCP config. opencode names tools `<server>_<tool>`. */
export const COMPASS_MCP_KEY = "compass"
export const WEB_SEARCH_MCP_KEY = "web_search"

export type OpencodeConfigInput = {
  /** Gateway model id, e.g. "anthropic/claude-sonnet-5.5". */
  model: string
  /** Absolute URL of Compass's /api/mcp. */
  mcpUrl: string
  /** Absolute URL of the Compass-hosted web_search MCP endpoint (optional). */
  webSearchUrl?: string
  /** Send the Vercel protection-bypass header (protected previews only). */
  withBypassHeader?: boolean
  /**
   * Test/override seam: route the model provider at an OpenAI-compatible base URL
   * instead of the real gateway. Used by the local mock-gateway validation; never set
   * by the host in production.
   */
  openAiCompatibleBaseUrl?: string
  /** Connected third-party MCP servers (already parsed with parseConnectors). */
  connectors?: ConnectorRef[]
}

export type ConnectorRef = { slug: string; displayName: string; guidance?: string }

const RESERVED_MCP_KEYS = [COMPASS_MCP_KEY, WEB_SEARCH_MCP_KEY]
const CONNECTOR_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_CONNECTOR_GUIDANCE_CHARS = 2000

/**
 * Parses AGENT_MCP_CONNECTORS exactly as turn-entry.ts does (kept separate rather than
 * shared so the Claude entry is untouched): malformed entries are dropped, never fatal.
 */
export function parseConnectors(raw: string | undefined, note: (message: string) => void = () => {}): ConnectorRef[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    note("AGENT_MCP_CONNECTORS is not valid JSON; continuing with Compass only")
    return []
  }
  if (!Array.isArray(parsed)) {
    note("AGENT_MCP_CONNECTORS is not an array; continuing with Compass only")
    return []
  }
  const refs: ConnectorRef[] = []
  for (const entry of parsed) {
    const slug = (entry as { slug?: unknown } | null)?.slug
    if (typeof slug !== "string" || !CONNECTOR_SLUG_RE.test(slug) || RESERVED_MCP_KEYS.includes(slug) || refs.some((ref) => ref.slug === slug)) {
      note(`ignoring connector with unusable or reserved slug: ${JSON.stringify(slug)}`)
      continue
    }
    const displayName = (entry as { displayName?: unknown }).displayName
    const guidance = (entry as { guidance?: unknown }).guidance
    refs.push({
      slug,
      displayName: typeof displayName === "string" && displayName ? displayName : slug,
      ...(typeof guidance === "string" && guidance.trim() ? { guidance: guidance.trim().slice(0, MAX_CONNECTOR_GUIDANCE_CHARS) } : {}),
    })
  }
  return refs
}

/** Guidance paragraph for the connectors enabled this turn (appended to the system prompt). */
export function connectorSystemPromptSection(connectors: ConnectorRef[]): string {
  const lines = connectors.filter((c) => c.guidance).map((c) => `${c.displayName}: ${c.guidance}`)
  return lines.length ? `\n\n## Connected third-party tools\n\n${lines.join("\n\n")}` : ""
}

/**
 * The opencode config. SECRETS NEVER APPEAR HERE: credentials are `{env:NAME}`
 * references that opencode resolves from its own process environment, so the
 * generated JSON (which is passed in OPENCODE_CONFIG_CONTENT and so visible to
 * `ps`/logs) carries no token.
 *
 * Permissions are deny-by-default: the `*` rule denies every tool, then only the
 * Compass MCP servers' tools are allowed. Built-in bash/edit/write/webfetch/task/etc.
 * therefore cannot run even if the model asks for them.
 */
export function buildOpencodeConfig(input: OpencodeConfigInput): Config {
  const mcpHeaders: Record<string, string> = { Authorization: "Bearer {env:MCP_TOKEN}" }
  if (input.withBypassHeader) mcpHeaders["x-vercel-protection-bypass"] = "{env:MCP_BYPASS_SECRET}"

  const provider: NonNullable<Config["provider"]> = input.openAiCompatibleBaseUrl
    ? {
        [GATEWAY_PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Mock gateway (validation only)",
          options: { baseURL: input.openAiCompatibleBaseUrl, apiKey: "{env:AI_GATEWAY_API_KEY}" },
          models: { [input.model]: { name: input.model, tool_call: true } },
        },
      }
    : {
        [GATEWAY_PROVIDER_ID]: {
          options: { apiKey: "{env:AI_GATEWAY_API_KEY}" },
        },
      }

  const mcp: NonNullable<Config["mcp"]> = {
    [COMPASS_MCP_KEY]: { type: "remote", url: input.mcpUrl, headers: mcpHeaders, oauth: false, enabled: true },
  }
  if (input.webSearchUrl) {
    mcp[WEB_SEARCH_MCP_KEY] = { type: "remote", url: input.webSearchUrl, headers: mcpHeaders, oauth: false, enabled: true }
  }

  // ADR-0018 connectors: one remote server per connected provider, reached through a
  // Compass gateway path with the SAME turn credential (slugs only; no provider token
  // is ever present here). Re-validated: the slug becomes a config key, a URL path
  // segment and a permission glob, and the reserved names can never be shadowed.
  const connectorSlugs: string[] = []
  for (const connector of input.connectors ?? []) {
    if (!CONNECTOR_SLUG_RE.test(connector.slug) || RESERVED_MCP_KEYS.includes(connector.slug) || connectorSlugs.includes(connector.slug)) continue
    mcp[connector.slug] = {
      type: "remote",
      url: new URL(`/api/integrations/mcp/${connector.slug}`, input.mcpUrl).toString(),
      headers: mcpHeaders,
      oauth: false,
      enabled: true,
    }
    connectorSlugs.push(connector.slug)
  }

  const allowedToolGlobs = [
    `${COMPASS_MCP_KEY}_*`,
    ...(input.webSearchUrl ? [`${WEB_SEARCH_MCP_KEY}_*`] : []),
    ...connectorSlugs.map((slug) => `${slug}_*`),
  ]

  return {
    model: `${GATEWAY_PROVIDER_ID}/${input.model}`,
    // Title/summary generation otherwise reaches for a second, default "small" model.
    small_model: `${GATEWAY_PROVIDER_ID}/${input.model}`,
    enabled_providers: [GATEWAY_PROVIDER_ID],
    provider,
    mcp,
    permission: {
      "*": "deny",
      ...Object.fromEntries(allowedToolGlobs.map((glob) => [glob, "allow"])),
    } as NonNullable<Config["permission"]>,
    agent: {
      title: { disable: true },
      summary: { disable: true },
    },
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    lsp: false,
    formatter: false,
    plugin: [],
    instructions: [],
  }
}

/** Env vars the opencode process is allowed to see; everything else is dropped. */
const PASSTHROUGH_ENV = ["PATH", "NODE_ENV", "TZ", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]
/** The only credentials opencode needs; resolved via the config's {env:...} references. */
const CREDENTIAL_ENV = ["AI_GATEWAY_API_KEY", "MCP_TOKEN", "MCP_BYPASS_SECRET"]

/**
 * The environment for the `opencode serve` child. Allow-list rather than deny-list,
 * so the run-callback token (AGENT_RUN_TOKEN), ANTHROPIC_API_KEY and anything the
 * host adds later never reach the process that executes model-driven tool calls.
 * HOME/XDG dirs point at a fresh private directory so no ambient ~/.config/opencode,
 * auth.json, or project config is loaded.
 */
export function opencodeProcessEnv(
  source: Record<string, string | undefined>,
  opts: { configJson: string; stateDir: string },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...PASSTHROUGH_ENV, ...CREDENTIAL_ENV]) {
    const value = source[key]
    if (value) env[key] = value
  }
  return {
    ...env,
    HOME: opts.stateDir,
    XDG_CONFIG_HOME: `${opts.stateDir}/config`,
    XDG_DATA_HOME: `${opts.stateDir}/data`,
    XDG_CACHE_HOME: `${opts.stateDir}/cache`,
    XDG_STATE_HOME: `${opts.stateDir}/state`,
    OPENCODE_CONFIG_CONTENT: opts.configJson,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_PURE: "1",
  }
}

/** Splits "provider/model" style ids the way opencode's prompt API wants them. */
export function gatewayModelRef(model: string): { providerID: string; modelID: string } {
  return { providerID: GATEWAY_PROVIDER_ID, modelID: model }
}

// ── tool names ──────────────────────────────────────────────────────────────

/**
 * opencode exposes MCP tools as `<server>_<tool>`; the rest of Compass (audit rows,
 * the tool strip, isMutationTool) knows the Claude SDK spelling `mcp__<server>__<tool>`.
 */
export function toCompassToolName(opencodeToolName: string, connectorSlugs: string[] = []): string {
  for (const server of [COMPASS_MCP_KEY, WEB_SEARCH_MCP_KEY, ...connectorSlugs]) {
    const prefix = `${server}_`
    if (opencodeToolName.startsWith(prefix)) return `mcp__${server}__${opencodeToolName.slice(prefix.length)}`
  }
  return opencodeToolName
}

// ── event mapping ───────────────────────────────────────────────────────────

/**
 * A harness-agnostic stream message, shaped like the Agent SDK's assistant/user
 * messages. The entry script wraps it as `AGENT_EVENT { type, message: <this> }`, which
 * is what consumers read as `payload.message.message.content`.
 */
export type AgentEventPayload = {
  type: "assistant" | "user"
  message: { role: "assistant" | "user"; content: Record<string, unknown>[] }
}

function assistantEvent(content: Record<string, unknown>[]): AgentEventPayload {
  return { type: "assistant", message: { role: "assistant", content } }
}

function userEvent(content: Record<string, unknown>[]): AgentEventPayload {
  return { type: "user", message: { role: "user", content } }
}

/** The subset of opencode's `Part` this adapter reads. Anything else is ignored. */
export type OpencodePartLike = {
  id: string
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  time?: { start?: number; end?: number }
  callID?: string
  tool?: string
  state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string }
}

export type OpencodeAssistantInfoLike = {
  id: string
  tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } }
  cost?: number
  error?: { name?: string; data?: { message?: string } }
}

/**
 * Folds the repeated `message.part.updated` stream into at-most-once Agent SDK style
 * events. opencode re-emits a tool part for every state change (pending, running,
 * completed); the consumers dedupe replays but a duplicate tool_result would still
 * be wasted traffic, so each tool_use and tool_result is emitted exactly once.
 */
export class OpencodeEventMapper {
  private readonly toolUseEmitted = new Set<string>()
  private readonly toolResultEmitted = new Set<string>()
  private readonly textEmitted = new Set<string>()
  private readonly connectorSlugs: string[]

  // Explicit field (no parameter property): this file runs under type-stripping.
  constructor(connectorSlugs: string[] = []) {
    this.connectorSlugs = connectorSlugs
  }

  mapPart(part: OpencodePartLike): AgentEventPayload[] {
    if (part.type === "text") {
      // Emit a text block once, when opencode marks it finished; partial deltas are not
      // forwarded (the run stream appends text blocks, so partials would duplicate).
      if (part.synthetic || part.ignored || !part.text || !part.time?.end) return []
      if (this.textEmitted.has(part.id)) return []
      this.textEmitted.add(part.id)
      return [assistantEvent([{ type: "text", text: part.text }])]
    }
    if (part.type !== "tool" || !part.tool || !part.state) return []
    const id = part.callID ?? part.id
    const events: AgentEventPayload[] = []
    const status = part.state.status
    if ((status === "running" || status === "completed" || status === "error") && !this.toolUseEmitted.has(id)) {
      this.toolUseEmitted.add(id)
      events.push(assistantEvent([{ type: "tool_use", id, name: toCompassToolName(part.tool, this.connectorSlugs), input: part.state.input ?? {} }]))
    }
    if ((status === "completed" || status === "error") && !this.toolResultEmitted.has(id)) {
      this.toolResultEmitted.add(id)
      events.push(
        userEvent([
          {
            type: "tool_result",
            tool_use_id: id,
            content: status === "completed" ? (part.state.output ?? "") : (part.state.error ?? "tool error"),
            is_error: status === "error",
          },
        ]),
      )
    }
    return events
  }
}

// ── result ──────────────────────────────────────────────────────────────────

/** Text of the final answer: the finished, non-synthetic text parts, in order. */
export function finalTextFromParts(parts: OpencodePartLike[]): string {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim()
}

/** Error message carried by an assistant message, if the turn failed inside the model call. */
export function assistantErrorMessage(info: OpencodeAssistantInfoLike): string | undefined {
  if (!info.error) return undefined
  return info.error.data?.message || info.error.name || "opencode assistant error"
}

/**
 * AGENT_RESULT usage in the shape the host persists (usage.usage.input_tokens,
 * numTurns, totalCostUsd, durationMs): summed over every model call in the turn.
 */
export function usageFromMessages(messages: OpencodeAssistantInfoLike[], durationMs: number) {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  for (const message of messages) {
    input += message.tokens?.input ?? 0
    output += (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
    cacheRead += message.tokens?.cache?.read ?? 0
    cacheWrite += message.tokens?.cache?.write ?? 0
    cost += message.cost ?? 0
  }
  return {
    durationMs,
    durationApiMs: durationMs,
    numTurns: messages.length,
    totalCostUsd: cost,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    },
  }
}

// ── session transcript ──────────────────────────────────────────────────────
//
// opencode keeps sessions in its own sqlite DB inside the (disposable) sandbox. Between
// turns the session travels as the output of `opencode export <id>` (plain JSON), which
// `opencode import <file>` restores in the next sandbox. The SDK's HTTP surface has no
// import call, which is why the entry script shells out to the CLI for these two steps.
//
// The blob is a gzip of one JSON object tagged with the harness: a Claude transcript
// (gzipped JSONL of SessionStore entries) can never parse as this, and this can never be
// fed to the Claude SDK, so a harness switch degrades to full text replay instead of
// to a corrupt resume. The host additionally tags the stored blob key (lib/agent-session.ts).

import { gunzipSync, gzipSync } from "node:zlib"

export const SESSION_FORMAT = "compass-opencode-session/1"
/** Decompressed ceiling for an inbound transcript: a bomb guard, not a product limit. */
const MAX_SESSION_JSON_BYTES = 128 * 1024 * 1024

/** `exportJson` is the stdout of `opencode export <id>`; returns the gzip to store. */
export function packOpencodeSession(exportJson: string): Buffer {
  const exported = JSON.parse(exportJson) as unknown
  return gzipSync(Buffer.from(JSON.stringify({ format: SESSION_FORMAT, harness: "opencode", opencodeVersion: OPENCODE_VERSION, export: exported }), "utf8"))
}

/** The JSON to hand to `opencode import`, or undefined for anything that is not an opencode transcript. */
export function unpackOpencodeSession(gz: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(gunzipSync(gz, { maxOutputLength: MAX_SESSION_JSON_BYTES }).toString("utf8")) as { format?: unknown; harness?: unknown; export?: unknown }
    if (parsed?.format !== SESSION_FORMAT || parsed.harness !== "opencode" || !parsed.export || typeof parsed.export !== "object") return undefined
    return JSON.stringify(parsed.export)
  } catch {
    return undefined
  }
}

/** The opencode session id inside an export (`info.id`), if present. */
export function sessionIdFromExport(exportJson: string): string | undefined {
  try {
    const id = (JSON.parse(exportJson) as { info?: { id?: unknown } })?.info?.id
    return typeof id === "string" && id ? id : undefined
  } catch {
    return undefined
  }
}
