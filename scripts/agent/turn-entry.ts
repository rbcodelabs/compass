// Agent turn entry script — runs INSIDE a Vercel Sandbox booted from the golden
// snapshot (deps pre-installed; see lib/agent-sandbox.ts). The host route
// (app/api/agent/turn/route.ts) writes this file into the sandbox and runs it
// per turn.
//
// It points the Claude Agent SDK at Compass's OWN /api/mcp catalog over HTTP,
// authenticated with an ephemeral per-user `cmp_` key — so the agent acts AS
// the user and Phase 1's per-user authorization scopes every tool. No custom
// tools, no DB access: the sandbox only makes authenticated MCP calls.
//
// ── Two transports, on purpose ──────────────────────────────────────────────
//
// stdout is kept exactly as it was: one prefixed JSON object per line. It is
// what the synchronous fallback path drains, and it is the only thing available
// when debugging a sandbox by hand.
//
// Additionally, when AGENT_RUN_ID + AGENT_RUN_TOKEN are present, every event is
// POSTed back to Compass in batches with a monotonic `seq`, plus a periodic
// heartbeat. That is what lets the run outlive the request that started it: the
// database, not the response body, becomes the durable seam. With those two vars
// absent this file behaves exactly as it did before, which is what makes the
// pre-migration fallback possible.
//
// Required env (passed at runCommand time, never baked into the snapshot):
//   ANTHROPIC_API_KEY          Claude API key for the Agent SDK
//   MCP_BASE_URL               Compass origin to call back into (/api/mcp, and
//                              the run callbacks below)
//   MCP_TOKEN                  ephemeral per-user cmp_ key (scopes the agent)
//   AGENT_PROMPT               the assembled prompt (history + user turn)
//   MCP_BYPASS_SECRET          (optional) x-vercel-protection-bypass for
//                              protected preview deployments; unused in prod
//   AGENT_MCP_CONNECTORS       (optional) JSON [{ slug, displayName, guidance? }]
//                              — third-party MCP servers this user has connected
//                              (ADR-0018). Slugs only: each is reached through a
//                              Compass gateway path with the turn credential
//                              above, so no provider token is passed in here.
//   AGENT_RUN_ID               (optional) durable run this turn belongs to
//   AGENT_RUN_TOKEN            (optional) that run's worker bearer token — a
//                              separate credential from MCP_TOKEN on purpose,
//                              so forging a transcript and acting as the user
//                              are not the same capability
//   AGENT_RUN_HEARTBEAT_MS     (optional) heartbeat interval; default 15000
//   AGENT_MAX_TURNS            (optional) per-run turn cap; default 30
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
const AGENT_RUN_ID = process.env.AGENT_RUN_ID
const AGENT_RUN_TOKEN = process.env.AGENT_RUN_TOKEN

function emit(kind: "AGENT_EVENT" | "AGENT_RESULT" | "AGENT_ERROR", payload: unknown): void {
  // Single line so the host can split stdout on newlines and forward as SSE.
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

/** Diagnostics about this script's own setup, which must never masquerade as agent output. */
function note(message: string): void {
  process.stderr.write(`[turn-entry] ${message}\n`)
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}


// ── Run reporter ────────────────────────────────────────────────────────────

type RunEventType = "status" | "agent" | "result" | "error" | "heartbeat"
type OutboundEvent = { seq: number; type: RunEventType; payload: unknown }

/** Server caps a batch at 32 events / 256 KiB; stay comfortably inside both. */
const FLUSH_EVENT_COUNT = 32
const FLUSH_INTERVAL_MS = 500
const MAX_BATCH_BYTES = 200 * 1024
/**
 * A single event larger than this is replaced by a marker rather than dropped or
 * allowed to blow the batch cap. Generalizes the old 1 MB stdout transport guard:
 * one pathological tool result should cost its own payload, not the transcript.
 */
const MAX_EVENT_BYTES = 64 * 1024
/** Bound on unsent events when Compass is unreachable. Beyond this the oldest go. */
const MAX_BACKLOG = 256
const DEFAULT_HEARTBEAT_MS = 15_000

class RunReporter {
  private queue: OutboundEvent[] = []
  private nextSeq = 1
  private flushing: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private dropped = 0
  /** Set when the server reports this run already terminal — the agent should stop. */
  canceledStatus: string | undefined

  private readonly eventsUrl: string
  private readonly heartbeatUrl: string
  private readonly headers: Record<string, string>
  private readonly heartbeatMs: number

  // Fields are declared and assigned explicitly rather than via TypeScript
  // parameter properties (`constructor(private readonly x: string)`). This file is
  // executed as `node entry.ts` inside the sandbox, where Node only *erases*
  // types; parameter properties need real codegen, so they abort the process at
  // load with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before a single heartbeat goes
  // out. Keep every construct in this file strip-only safe — see the guard in
  // __tests__/agent-entry-scripts.test.ts.
  constructor(
    eventsUrl: string,
    heartbeatUrl: string,
    headers: Record<string, string>,
    heartbeatMs: number,
  ) {
    this.eventsUrl = eventsUrl
    this.heartbeatUrl = heartbeatUrl
    this.headers = headers
    this.heartbeatMs = heartbeatMs
  }

  start() {
    this.heartbeat = setInterval(() => { void this.sendHeartbeat() }, this.heartbeatMs)
    // The interval must never be the reason the process stays alive.
    this.heartbeat.unref?.()
  }

  enqueue(type: RunEventType, payload: unknown) {
    let serialized = payload
    const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), "utf8")
    if (bytes > MAX_EVENT_BYTES) serialized = { truncated: true, type, bytes }
    this.queue.push({ seq: this.nextSeq++, type, payload: serialized })
    if (this.queue.length > MAX_BACKLOG) {
      // Drop from the head: the tail is what a watching user is reading, and a
      // backlog this deep means Compass has been unreachable for a while.
      this.dropped += this.queue.length - MAX_BACKLOG
      this.queue = this.queue.slice(this.queue.length - MAX_BACKLOG)
    }
    if (this.queue.length >= FLUSH_EVENT_COUNT) {
      void this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush() }, FLUSH_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /** Serialized so two flushes cannot interleave and reorder sequences. */
  flush(attempts = 2): Promise<void> {
    this.flushing = this.flushing.then(() => this.drain(attempts)).catch(() => {})
    return this.flushing
  }

  private takeBatch(): OutboundEvent[] {
    const batch: OutboundEvent[] = []
    let bytes = 0
    while (this.queue.length > 0 && batch.length < FLUSH_EVENT_COUNT) {
      const next = this.queue[0]!
      const size = Buffer.byteLength(JSON.stringify(next), "utf8")
      if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break
      batch.push(next)
      bytes += size
      this.queue.shift()
    }
    return batch
  }

  private async drain(attempts: number) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.queue.length > 0) {
      const batch = this.takeBatch()
      if (batch.length === 0) break
      const delivered = await this.post(this.eventsUrl, { events: batch }, attempts)
      if (!delivered) {
        // Put them back at the head so ordering survives a transient failure.
        this.queue = [...batch, ...this.queue]
        return
      }
    }
    if (this.dropped > 0) {
      note(`dropped ${this.dropped} event(s) after the backlog cap was reached`)
      this.dropped = 0
    }
  }

  private async post(url: string, body: unknown, attempts: number): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...this.headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        if (response.ok) {
          const data = await response.json().catch(() => null) as { status?: string } | null
          // 4xx other than 409 means retrying cannot help: a revoked token, a
          // finished run, or a batch the server will never accept.
          if (data?.status && data.status !== "QUEUED" && data.status !== "RUNNING") {
            this.canceledStatus = data.status
          }
          return true
        }
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          this.canceledStatus = `HTTP_${response.status}`
          note(`callback rejected with ${response.status}; giving up on this channel`)
          return false
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429) {
          note(`callback refused with ${response.status}; dropping batch`)
          return true
        }
        note(`callback attempt ${attempt} failed with ${response.status}`)
      } catch (error) {
        note(`callback attempt ${attempt} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
    return false
  }

  private async sendHeartbeat() {
    try {
      const response = await fetch(this.heartbeatUrl, { method: "POST", headers: this.headers })
      if (!response.ok) {
        if (response.status === 401 || response.status === 404) this.canceledStatus = `HTTP_${response.status}`
        return
      }
      const data = await response.json().catch(() => null) as { status?: string } | null
      if (data?.status && data.status !== "QUEUED" && data.status !== "RUNNING") this.canceledStatus = data.status
    } catch {
      // A missed heartbeat is not itself fatal; the sweeper's margin covers
      // several of them, and event batches also refresh the heartbeat.
    }
  }

  /**
   * Deliver the terminal event and stop.
   *
   * Retried harder than an ordinary batch: losing this one means the run sits
   * `RUNNING` until the sweeper marks it `INTERRUPTED`, which is a materially
   * worse outcome for the user than a missing intermediate event.
   */
  async finish(type: "result" | "error", payload: unknown) {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.canceledStatus) {
      note(`run already terminal (${this.canceledStatus}); not reporting ${type}`)
      return
    }
    this.enqueue(type, payload)
    await this.flush(5)
  }
}

let reporter: RunReporter | undefined

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

  if (AGENT_RUN_ID && AGENT_RUN_TOKEN) {
    const callbackHeaders: Record<string, string> = { Authorization: `Bearer ${AGENT_RUN_TOKEN}` }
    if (MCP_BYPASS_SECRET) callbackHeaders["x-vercel-protection-bypass"] = MCP_BYPASS_SECRET
    const heartbeatMs = Number(process.env.AGENT_RUN_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS
    reporter = new RunReporter(
      new URL(`/api/internal/agent/runs/${AGENT_RUN_ID}/events`, baseUrl).toString(),
      new URL(`/api/internal/agent/runs/${AGENT_RUN_ID}/heartbeat`, baseUrl).toString(),
      callbackHeaders,
      heartbeatMs,
    )
    reporter.start()
    reporter.enqueue("status", { phase: "running" })
  }

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
      maxTurns: Number(process.env.AGENT_MAX_TURNS) || 30,
    },
  })) {
    emit("AGENT_EVENT", { type: message.type, message })
    reporter?.enqueue("agent", { type: message.type, message })

    // Canceled or swept out from under us: stop spending model tokens on a
    // result nobody will accept. The server is already terminal, so there is
    // nothing to report back.
    if (reporter?.canceledStatus) {
      note(`stopping early: run is ${reporter.canceledStatus}`)
      emit("AGENT_ERROR", { message: `run terminated server-side (${reporter.canceledStatus})` })
      process.exitCode = 1
      return
    }

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
        throw new Error(`query() ended with subtype: ${message.subtype}`)
      }
    }
  }

  if (finalText === undefined) throw new Error("query() ended without a success result")
  emit("AGENT_RESULT", { text: finalText, usage })
  await reporter?.finish("result", { text: finalText, usage })
}

main().catch(async (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  emit("AGENT_ERROR", { message })
  try {
    await reporter?.finish("error", { message })
  } catch {
    /* the sweeper is the backstop when even the terminal report cannot land */
  }
  process.exit(1)
})
