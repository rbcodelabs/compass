// Agent turn entry script — runs INSIDE a Vercel Sandbox booted from the golden
// snapshot (deps pre-installed; see lib/agent-sandbox.ts). The host route
// (app/api/agent/turn/route.ts) writes this file into the sandbox and runs it
// per turn, streaming its stdout back to the browser.
//
// It points the Claude Agent SDK at Compass's OWN /api/mcp catalog over HTTP,
// authenticated with an ephemeral per-user `cmp_` key — so the agent acts AS
// the user and Phase 1's per-user authorization scopes every tool. No custom
// tools, no DB access: the sandbox only makes authenticated MCP calls.
//
// Required env (passed at runCommand time, never baked into the snapshot):
//   ANTHROPIC_API_KEY          Claude API key for the Agent SDK
//   MCP_BASE_URL               Compass origin to call back into (/api/mcp)
//   MCP_TOKEN                  ephemeral per-user cmp_ key (scopes the agent)
//   AGENT_PROMPT               the assembled prompt (history + user turn)
//   MCP_BYPASS_SECRET          (optional) x-vercel-protection-bypass for
//                              protected preview deployments; unused in prod
//   AGENT_MCP_CONNECTORS       (optional) JSON [{ slug, displayName, guidance? }]
//                              — third-party MCP servers this user has connected
//                              (ADR-0018). Slugs only: each is reached through a
//                              Compass gateway path with the turn credential
//                              above, so no provider token is passed in here.
//
// Output contract (one JSON object per line, prefixed):
//   AGENT_EVENT <json>   — each SDK stream message (assistant/tool/system)
//   AGENT_RESULT <json>  — final { text, usage } on success
//   AGENT_ERROR <json>   — { message } on failure

import { query } from "@anthropic-ai/claude-agent-sdk"

const MCP_BASE_URL = process.env.MCP_BASE_URL
const MCP_TOKEN = process.env.MCP_TOKEN
const AGENT_PROMPT = process.env.AGENT_PROMPT
const AGENT_SYSTEM_PROMPT = process.env.AGENT_SYSTEM_PROMPT
const AGENT_PACK_CONFIG = process.env.AGENT_PACK_CONFIG
const MCP_BYPASS_SECRET = process.env.MCP_BYPASS_SECRET
const AGENT_MCP_CONNECTORS = process.env.AGENT_MCP_CONNECTORS

function emit(kind: "AGENT_EVENT" | "AGENT_RESULT" | "AGENT_ERROR", payload: unknown): void {
  // Single line so the host can split stdout on newlines and forward as SSE.
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

/** Diagnostics about this script's own setup, which must never masquerade as agent output. */
function note(message: string): void {
  process.stderr.write(`[turn-entry] ${message}\n`)
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    emit("AGENT_ERROR", { message: `Missing required env var: ${name}` })
    process.exit(1)
  }
  return value
}


// ── Outbound MCP connectors (ADR-0018) ──────────────────────────────────────

type ConnectorRef = { slug: string; displayName: string; guidance?: string }

/** The shape the Agent SDK's `mcpServers` map takes for an HTTP transport. */
type McpHttpServer = {
  type: "http"
  url: string
  headers: Record<string, string>
  alwaysLoad?: boolean
}

/** Per connector. Generous for a paragraph of advice, far short of a prompt injection budget. */
const MAX_CONNECTOR_GUIDANCE_CHARS = 2000

/**
 * Parses AGENT_MCP_CONNECTORS, dropping anything malformed rather than throwing.
 *
 * A bad entry must not cost the user their turn: the connectors are an additive
 * capability, and the agent is perfectly useful with only Compass's own catalog.
 * The slug is re-validated here even though the host built the value, because it
 * is interpolated into both a URL path and an `mcp__<slug>` tool-name prefix —
 * two places where a stray character would either widen the allowlist or point
 * the SDK somewhere unintended.
 */
function parseConnectors(raw: string | undefined): ConnectorRef[] {
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
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
      note(`ignoring connector with unusable slug: ${JSON.stringify(slug)}`)
      continue
    }
    const displayName = (entry as { displayName?: unknown }).displayName
    const guidance = (entry as { guidance?: unknown }).guidance
    refs.push({
      slug,
      displayName: typeof displayName === "string" && displayName ? displayName : slug,
      // Capped rather than trusted wholesale: it is appended to the system
      // prompt, and the host is the only writer, but a runaway value would
      // silently eat the context budget the actual turn needs.
      ...(typeof guidance === "string" && guidance.trim()
        ? { guidance: guidance.trim().slice(0, MAX_CONNECTOR_GUIDANCE_CHARS) }
        : {}),
    })
  }
  return refs
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("MCP_BASE_URL", MCP_BASE_URL)
  const token = requireEnv("MCP_TOKEN", MCP_TOKEN)
  const prompt = requireEnv("AGENT_PROMPT", AGENT_PROMPT)
  const systemPrompt = requireEnv("AGENT_SYSTEM_PROMPT", AGENT_SYSTEM_PROMPT)
  requireEnv("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY)

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (MCP_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = MCP_BYPASS_SECRET
  const packConfig = AGENT_PACK_CONFIG
    ? JSON.parse(AGENT_PACK_CONFIG) as { pluginPaths: string[]; skillIds: string[] }
    : { pluginPaths: [], skillIds: [] }

  // Compass's own catalog plus one HTTP entry per connected provider. Each
  // connector points at a Compass gateway path, not the provider — the sandbox
  // presents its own turn credential and Compass attaches the third-party bearer
  // on the way out, so no provider token is ever present in this microVM.
  // `alwaysLoad` is deliberately NOT set on the connectors: Compass's own catalog
  // is what the agent needs every turn, whereas a connector's tools are worth
  // discovering on demand rather than spending context on unconditionally.
  const mcpServers: Record<string, McpHttpServer> = {
    compass: {
      type: "http",
      url: new URL("/api/mcp", baseUrl).toString(),
      headers,
      // Load the full Compass catalog into the prompt up front instead of
      // deferring it behind ToolSearch. Without this the agent burns turns
      // searching for tools; with it, it can act directly.
      alwaysLoad: true,
    },
  }
  const connectors = parseConnectors(AGENT_MCP_CONNECTORS)
  const connectorToolPrefixes: string[] = []
  const connectorGuidance: string[] = []
  for (const connector of connectors) {
    // `compass` is this file's own entry, and shadowing it would silently
    // redirect the agent's entire tool catalog through the gateway.
    if (Object.prototype.hasOwnProperty.call(mcpServers, connector.slug)) {
      note(`ignoring connector "${connector.slug}": name is reserved`)
      continue
    }
    mcpServers[connector.slug] = {
      type: "http",
      url: new URL(`/api/integrations/mcp/${connector.slug}`, baseUrl).toString(),
      headers,
    }
    connectorToolPrefixes.push(`mcp__${connector.slug}`)
    if (connector.guidance) connectorGuidance.push(`${connector.displayName}: ${connector.guidance}`)
  }
  if (connectorToolPrefixes.length > 0) note(`connectors enabled: ${connectorToolPrefixes.join(", ")}`)

  // Appended after the host's prompt rather than merged into it, because it is
  // scoped to *this* turn's grants: the host prompt is the same for every user,
  // and this paragraph only exists while the connector it describes is reachable.
  const effectiveSystemPrompt = connectorGuidance.length
    ? `${systemPrompt}\n\n## Connected third-party tools\n\n${connectorGuidance.join("\n\n")}`
    : systemPrompt

  let finalText: string | undefined
  let usage: unknown

  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-5",
      // Compass's own MCP catalog, reached AS the acting user, plus this turn's
      // connectors. Built above.
      mcpServers,
      plugins: packConfig.pluginPaths.map((pluginPath) => ({
        type: "local" as const,
        path: new URL(pluginPath, `file://${process.cwd()}/`).pathname,
        skipMcpDiscovery: true,
      })),
      skills: packConfig.skillIds,
      // Skill bodies and supported text assets are compiled into systemPrompt
      // by the host. SDK 0.3.224 does not provide Skill/Read with tools: [].
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      systemPrompt: effectiveSystemPrompt,
      // Compass MCP only, auto-approved. Headless (no human approver): the
      // real security boundary is the disposable sandbox + per-user MCP auth.
      allowedTools: ["mcp__compass", ...connectorToolPrefixes],
      // Safety default (Phase 5): keep the two irreversible hard-delete tools
      // out of the agent's reach — everything else is reversible/auditable.
      // Remove entries here to let the agent perform destructive deletes.
      disallowedTools: ["mcp__compass__delete_assumption", "mcp__compass__delete_solution_comment"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
    },
  })) {
    emit("AGENT_EVENT", { type: message.type, message })

    if (message.type === "result") {
      if (message.subtype === "success") {
        finalText = message.result
        usage = {
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          numTurns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          usage: message.usage,
        }
      } else {
        emit("AGENT_ERROR", { message: `query() ended with subtype: ${message.subtype}` })
        process.exit(1)
      }
    }
  }

  if (finalText === undefined) {
    emit("AGENT_ERROR", { message: "query() ended without a success result" })
    process.exit(1)
  }
  emit("AGENT_RESULT", { text: finalText, usage })
}

main().catch((err: unknown) => {
  emit("AGENT_ERROR", { message: err instanceof Error ? err.message : String(err) })
  process.exit(1)
})
