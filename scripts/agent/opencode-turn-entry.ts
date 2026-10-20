// EXPERIMENTAL opencode agent turn entry (default off; AGENT_HARNESS=opencode).
//
// Alternative to turn-entry.ts: runs the agent with opencode (headless server +
// @opencode-ai/sdk v2) against a model served by Vercel AI Gateway, instead of the
// Claude Agent SDK. The host (app/api/agent/turn/route.ts) writes this file into a
// Vercel Sandbox as entry.ts, with its sibling modules, and runs `node entry.ts`.
//
// The OUTPUT CONTRACT IS TURN-ENTRY.TS'S, unchanged:
//   AGENT_EVENT <json>   stream messages in the Agent SDK shape (assistant text /
//                        tool_use, user tool_result) so lib/agent-run-stream.ts and
//                        the mutation audit need no changes
//   AGENT_RESULT <json>  { text, usage }
//   AGENT_ERROR <json>   { message }
// plus the same run callbacks (batched events, heartbeat, terminal event) through the
// shared ./run-reporter.ts. All opencode-specific shapes live in ./opencode-adapter.ts.
//
// Env (passed at runCommand time, never baked into a snapshot):
//   AI_GATEWAY_API_KEY   Vercel AI Gateway key (required). VERCEL_OIDC_TOKEN is the
//                        in-Vercel alternative but is deliberately not forwarded into
//                        sandboxes by the host; see lib/agent-harness.ts.
//   AGENT_MODEL          gateway model id, default anthropic/claude-sonnet-5.5
//   MCP_BASE_URL, MCP_TOKEN, AGENT_PROMPT, AGENT_SYSTEM_PROMPT, MCP_BYPASS_SECRET,
//   AGENT_RUN_ID, AGENT_RUN_TOKEN, AGENT_RUN_HEARTBEAT_MS   as in turn-entry.ts
//   OPENCODE_BIN         (optional) path to the opencode binary
//   AGENT_OPENCODE_OPENAI_BASE_URL  (validation only) point the provider at an
//                        OpenAI-compatible mock instead of the gateway
//
// Not supported in this slice (turn-entry.ts features intentionally left out): doc
// file materialization (docs stay reachable through the Compass MCP write_doc tools),
// capability-pack plugin directories. Pack skill instructions still apply: the host
// compiles them into AGENT_SYSTEM_PROMPT. Permissions are deny-by-default: only the
// Compass, web_search and connected-connector MCP tools run (AGENT_MCP_CONNECTORS
// slugs, each a remote server behind a Compass gateway path with the turn credential).

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import {
  assistantErrorMessage,
  buildOpencodeConfig,
  finalTextFromParts,
  gatewayModelRef,
  connectorSystemPromptSection,
  OpencodeEventMapper,
  parseConnectors,
  opencodeProcessEnv,
  packOpencodeSession,
  sessionIdFromExport,
  unpackOpencodeSession,
  usageFromMessages,
  type OpencodeAssistantInfoLike,
  type OpencodePartLike,
} from "./opencode-adapter.ts"
import { DEFAULT_HEARTBEAT_MS, RunReporter } from "./run-reporter.ts"

/** Mirrors lib/agent-session.ts; the server re-validates, this just avoids a doomed upload. */
const MAX_AGENT_SESSION_BYTES = 4_000_000
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_IN_FILE = "session-in.jsonl.gz"
const SESSION_OUT_FILE = "session-out.jsonl.gz"
const FALLBACK_PROMPT_FILE = "fallback-prompt.txt"
const AGENT_SESSION_ID = process.env.AGENT_SESSION_ID

const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5"
const SERVER_START_TIMEOUT_MS = 30_000
/** Hard ceiling for one turn when the host gives none. */
const DEFAULT_TURN_TIMEOUT_MS = 4 * 60_000

function emit(kind: "AGENT_EVENT" | "AGENT_RESULT" | "AGENT_ERROR" | "AGENT_SESSION", payload: unknown): void {
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

/** Diagnostics about this script's own setup; never agent output. */
function note(message: string): void {
  process.stderr.write(`[opencode-turn-entry] ${message}\n`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

let reporter: RunReporter | undefined

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function resolveOpencodeBinary(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const local = path.join(process.cwd(), "node_modules", ".bin", "opencode")
  return existsSync(local) ? local : "opencode"
}

/** Starts `opencode serve` with the scrubbed env and resolves with its URL. */
async function startOpencodeServer(env: Record<string, string>, cwd: string): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort()
  const proc: ChildProcess = spawn(resolveOpencodeBinary(), ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    env: env as NodeJS.ProcessEnv,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const url = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timer = setTimeout(() => reject(new Error(`opencode server did not start within ${SERVER_START_TIMEOUT_MS}ms`)), SERVER_START_TIMEOUT_MS)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/opencode server listening on\s+(https?:\/\/\S+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    }
    proc.stdout?.on("data", onData)
    proc.stderr?.on("data", onData)
    proc.once("error", (error) => { clearTimeout(timer); reject(error) })
    proc.once("exit", (code) => { clearTimeout(timer); reject(new Error(`opencode server exited with code ${code}: ${output.slice(-500)}`)) })
  })
  return { url, proc }
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("MCP_BASE_URL")
  requireEnv("MCP_TOKEN")
  requireEnv("AI_GATEWAY_API_KEY")
  const prompt = requireEnv("AGENT_PROMPT")
  const systemPrompt = requireEnv("AGENT_SYSTEM_PROMPT")
  const model = process.env.AGENT_MODEL || DEFAULT_MODEL
  const runId = process.env.AGENT_RUN_ID
  const runToken = process.env.AGENT_RUN_TOKEN
  const startedAt = Date.now()

  if (runId && runToken) {
    const headers: Record<string, string> = { Authorization: `Bearer ${runToken}` }
    if (process.env.MCP_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.MCP_BYPASS_SECRET
    const heartbeatMs = Number(process.env.AGENT_RUN_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS
    reporter = new RunReporter(
      new URL(`/api/internal/agent/runs/${runId}/events`, baseUrl).toString(),
      new URL(`/api/internal/agent/runs/${runId}/heartbeat`, baseUrl).toString(),
      headers,
      heartbeatMs,
      note,
    )
    reporter.start()
    reporter.enqueue("status", { phase: "running" })
  }

  const stateDir = await mkdtemp(path.join(tmpdir(), "opencode-state-"))
  const workDir = await mkdtemp(path.join(tmpdir(), "opencode-work-"))
  const connectors = parseConnectors(process.env.AGENT_MCP_CONNECTORS, note)
  const effectiveSystemPrompt = `${systemPrompt}${connectorSystemPromptSection(connectors)}`
  if (connectors.length > 0) note(`connectors enabled: ${connectors.map((c) => c.slug).join(", ")}`)
  const config = buildOpencodeConfig({
    connectors,
    model,
    mcpUrl: new URL("/api/mcp", baseUrl).toString(),
    webSearchUrl: new URL("/api/agent/web-search/mcp", baseUrl).toString(),
    withBypassHeader: Boolean(process.env.MCP_BYPASS_SECRET),
    openAiCompatibleBaseUrl: process.env.AGENT_OPENCODE_OPENAI_BASE_URL || undefined,
  })
  const env = opencodeProcessEnv(process.env, { configJson: JSON.stringify(config), stateDir })

  // Session resume. Anything that goes wrong loading or resuming the prior transcript
  // degrades to a brand-new session driven by the full text replay the host also sent.
  const requestedSessionId = AGENT_SESSION_ID && SESSION_UUID_RE.test(AGENT_SESSION_ID) ? AGENT_SESSION_ID : undefined
  const resuming = Boolean(requestedSessionId) && process.env.AGENT_SESSION_MODE === "resume"
  let activeSessionId = requestedSessionId
  let promptText = prompt
  let resumedOpencodeId: string | undefined
  const fallbackToReplay = () => {
    // A resumed-then-abandoned id may already name a partial transcript, so never reuse it.
    activeSessionId = randomUUID()
    promptText = existsSync(FALLBACK_PROMPT_FILE) ? readFileSync(FALLBACK_PROMPT_FILE, "utf8") : prompt
  }
  if (resuming) {
    resumedOpencodeId = importPriorSession(env, workDir, stateDir)
    if (!resumedOpencodeId) {
      note("session transcript is missing, malformed or from another harness; starting a new session from the text replay")
      fallbackToReplay()
    }
  }

  const { url, proc } = await startOpencodeServer(env, workDir)
  const abort = new AbortController()
  const turnTimeout = setTimeout(() => abort.abort(new Error("turn timed out")), Number(process.env.AGENT_TURN_TIMEOUT_MS) || DEFAULT_TURN_TIMEOUT_MS)
  try {
    const client = createOpencodeClient({ baseUrl: url, directory: workDir, throwOnError: true })
    let sessionID: string
    if (resumedOpencodeId) {
      const found = await client.session.get({ sessionID: resumedOpencodeId }).catch(() => undefined)
      if (found?.data) {
        sessionID = resumedOpencodeId
      } else {
        note("imported session could not be opened; starting a new session from the text replay")
        fallbackToReplay()
        sessionID = await createSession(client)
      }
    } else {
      sessionID = await createSession(client)
    }

    const mapper = new OpencodeEventMapper(connectors.map((c) => c.slug))
    const assistantMessages = new Map<string, OpencodeAssistantInfoLike>()
    let streamError: string | undefined
    const pump = (async () => {
      const subscription = await client.event.subscribe(undefined, { signal: abort.signal })
      for await (const event of subscription.stream) {
        // Loosely typed on purpose: only these three event kinds are read, and a new
        // kind from a future opencode must not break the turn.
        const e = event as { type?: string; properties?: Record<string, unknown> }
        const props = e.properties ?? {}
        if (props.sessionID !== sessionID && (props.info as { sessionID?: string } | undefined)?.sessionID !== sessionID) continue
        if (e.type === "message.updated") {
          const info = props.info as (OpencodeAssistantInfoLike & { role?: string }) | undefined
          if (info?.role === "assistant") assistantMessages.set(info.id, info)
        } else if (e.type === "message.part.updated") {
          for (const payload of mapper.mapPart(props.part as OpencodePartLike)) {
            emit("AGENT_EVENT", { type: payload.type, message: payload })
            reporter?.enqueue("agent", { type: payload.type, message: payload })
          }
        } else if (e.type === "session.error") {
          const error = props.error as { data?: { message?: string }; name?: string } | undefined
          streamError = error?.data?.message || error?.name || "opencode session error"
        }
        if (reporter?.canceledStatus) {
          note(`stopping early: run is ${reporter.canceledStatus}`)
          abort.abort(new Error(`run terminated server-side (${reporter.canceledStatus})`))
        }
      }
    })().catch((error) => { if (!abort.signal.aborted) note(`event stream ended: ${error instanceof Error ? error.message : String(error)}`) })

    const prompted = await client.session.prompt(
      { sessionID, model: gatewayModelRef(model), system: effectiveSystemPrompt, parts: [{ type: "text", text: promptText }] },
      { signal: abort.signal },
    )
    const response = prompted.data
    if (!response) throw new Error("opencode returned no response to the prompt")

    // The prompt response is authoritative for the final message; give the event
    // stream a beat to flush the last part updates before closing it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    assistantMessages.set(response.info.id, response.info)
    abort.abort()
    await pump

    const failure = assistantErrorMessage(response.info) ?? streamError
    const finalText = finalTextFromParts(response.parts as OpencodePartLike[])
    if (failure && !finalText) throw new Error(failure)
    if (!finalText) throw new Error("opencode finished without a text answer")

    // Before the terminal report: a detached run's worker token stops working the moment
    // the run is terminal, so the transcript upload has to land first.
    if (activeSessionId) await publishSession(env, workDir, sessionID, activeSessionId, baseUrl, runId)

    const usage = usageFromMessages([...assistantMessages.values()], Date.now() - startedAt)
    emit("AGENT_RESULT", { text: finalText, usage })
    await reporter?.finish("result", { text: finalText, usage })
  } finally {
    clearTimeout(turnTimeout)
    proc.kill("SIGTERM")
    await rm(stateDir, { recursive: true, force: true }).catch(() => {})
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function createSession(client: ReturnType<typeof createOpencodeClient>): Promise<string> {
  const created = await client.session.create({ title: "compass-agent-turn" })
  if (!created.data) throw new Error("opencode did not return a session")
  return created.data.id
}

/** `opencode import` of the prior transcript; returns the restored session id, or undefined on any problem. */
function importPriorSession(env: Record<string, string>, cwd: string, stateDir: string): string | undefined {
  try {
    if (!existsSync(SESSION_IN_FILE)) return undefined
    const json = unpackOpencodeSession(readFileSync(SESSION_IN_FILE))
    if (!json) return undefined
    const id = sessionIdFromExport(json)
    if (!id) return undefined
    const file = path.join(stateDir, "session-import.json")
    writeFileSync(file, json)
    const result = spawnSync(resolveOpencodeBinary(), ["import", file], { env: env as NodeJS.ProcessEnv, cwd, encoding: "utf8", timeout: 60_000 })
    if (result.status !== 0) {
      note(`opencode import failed (${result.status}): ${(result.stderr || "").slice(-300)}`)
      return undefined
    }
    return id
  } catch (error) {
    note(`session import failed: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Export, store locally (sync path) and upload (detached path). Never throws: losing it costs the next turn its memory, not this turn its answer. */
async function publishSession(env: Record<string, string>, cwd: string, opencodeId: string, sessionId: string, baseUrl: string, runId: string | undefined): Promise<void> {
  try {
    const exported = spawnSync(resolveOpencodeBinary(), ["export", opencodeId], { env: env as NodeJS.ProcessEnv, cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 })
    if (exported.status !== 0) {
      note(`opencode export failed (${exported.status}): ${(exported.stderr || "").slice(-300)}`)
      return
    }
    const gz = packOpencodeSession(exported.stdout)
    if (gz.length > MAX_AGENT_SESSION_BYTES) {
      note(`transcript is ${gz.length} bytes gzipped (cap ${MAX_AGENT_SESSION_BYTES}); not saving; the next turn falls back to text replay`)
      return
    }
    // Sync turns have no upload channel: the host reads this file back out.
    writeFileSync(SESSION_OUT_FILE, gz)
    emit("AGENT_SESSION", { sessionId })
    const runToken = process.env.AGENT_RUN_TOKEN
    if (!reporter || !runId || !runToken) return
    const headers: Record<string, string> = {
      Authorization: `Bearer ${runToken}`,
      "content-type": "application/gzip",
      "x-agent-session-id": sessionId,
      "x-agent-session-harness": "opencode",
    }
    if (process.env.MCP_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.MCP_BYPASS_SECRET
    const url = new URL(`/api/internal/agent/runs/${runId}/session`, baseUrl).toString()
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetch(url, { method: "POST", headers, body: new Uint8Array(gz) })
        if (response.ok) return
        note(`session upload attempt ${attempt} returned ${response.status}`)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) return
      } catch (error) {
        note(`session upload attempt ${attempt} threw: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } catch (error) {
    note(`session publish failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    emit("AGENT_ERROR", { message })
    try {
      await reporter?.finish("error", { message })
    } catch {
      /* the sweeper is the backstop when even the terminal report cannot land */
    }
    process.exit(1)
  },
)
