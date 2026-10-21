// Local validation stack for the EXPERIMENTAL opencode harness (not shipped to sandboxes).
//
//   node scripts/agent/dev/opencode-validation-stack.mjs [--mock-gateway]
//
// Starts:
//   - a stub Compass MCP server at http://127.0.0.1:<MCP_PORT>/api/mcp that requires
//     `Authorization: Bearer $STUB_MCP_TOKEN`, with tools/list and one tool
//     (get_workspace_summary) returning canned data. Stands in for a Compass dev server
//     when no dev database is available.
//   - with --mock-gateway: an OpenAI-compatible /v1/chat/completions mock that first
//     requests a tool call, then answers from the tool result. Only for pipeline
//     validation when no real AI_GATEWAY_API_KEY exists.
//
// Prints one JSON line with the ports, then logs request evidence to stderr. Never logs
// token values.

import { createServer } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"

const token = process.env.STUB_MCP_TOKEN
if (!token) throw new Error("STUB_MCP_TOKEN is required")
const withMockGateway = process.argv.includes("--mock-gateway")
const log = (line) => process.stderr.write(`[stack] ${line}\n`)

function buildMcp() {
  const server = new McpServer({ name: "compass-stub", version: "0.0.1" })
  server.registerTool(
    "get_workspace_summary",
    {
      description: "Returns a summary of the Compass workspace: its name and open opportunity count.",
      inputSchema: { workspaceId: z.string().describe("Workspace id") },
    },
    async ({ workspaceId }) => {
      log(`MCP tool call get_workspace_summary workspaceId=${workspaceId}`)
      return { content: [{ type: "text", text: JSON.stringify({ workspaceId, name: "Acme Roadmap", openOpportunities: 7 }) }] }
    },
  )
  return server
}

const mcpHttp = createServer(async (req, res) => {
  // Run-callback stand-in (/api/internal/agent/runs/:id/{events,heartbeat}): logs what a
  // detached run would deliver to Compass.
  if (req.url?.includes("/api/internal/agent/runs/")) {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const kind = req.url.endsWith("/heartbeat") ? "heartbeat" : "events"
    const events = kind === "events" ? JSON.parse(raw).events : []
    log(`CALLBACK ${kind} auth=${req.headers.authorization === "Bearer run-token-for-validation" ? "run-token" : "WRONG"} ${events.map((e) => `${e.seq}:${e.type}`).join(" ")}`)
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "RUNNING" }))
    return
  }
  const authorized = req.headers.authorization === `Bearer ${token}`
  log(`MCP ${req.method} ${req.url} authorized=${authorized}`)
  if (!authorized) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }))
    return
  }
  if (req.method !== "POST") {
    res.writeHead(405).end()
    return
  }
  const server = buildMcp()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on("close", () => { transport.close(); server.close() })
  let body = ""
  for await (const chunk of req) body += chunk
  await server.connect(transport)
  await transport.handleRequest(req, res, JSON.parse(body))
})

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write("data: [DONE]\n\n")
  res.end()
}

const mockGateway = createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end()
    return
  }
  const body = JSON.parse(raw)
  log(`GATEWAY chat/completions auth=${req.headers.authorization ? "present" : "absent"} tools=${(body.tools ?? []).map((t) => t.function?.name).join(",")}`)
  const toolMessage = [...body.messages].reverse().find((m) => m.role === "tool")
  const base = { id: "mock-1", object: "chat.completion.chunk", created: 0, model: body.model }
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user")
  const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "")
  const reply = (text) => sse(res, [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }])
  if (!toolMessage && /codeword\?/.test(lastUserText)) {
    // Session-resume probe: answers only from what is actually in the request's history.
    const seen = JSON.stringify(body.messages).match(/codeword is ([A-Z]+)/)
    log(`GATEWAY recall probe messages=${body.messages.length} found=${seen ? "yes" : "no"}`)
    reply(seen ? `The codeword is ${seen[1]}.` : "I do not know the codeword.")
    return
  }
  if (!toolMessage && !/Compass tool/.test(lastUserText)) {
    reply("OK")
    return
  }
  if (!toolMessage) {
    const tool =(body.tools ?? []).find((t) => t.function?.name.endsWith("get_workspace_summary"))
    if (!tool) {
      sse(res, [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "No Compass tool was offered." }, finish_reason: "stop" }] }])
      return
    }
    sse(res, [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: tool.function.name, arguments: JSON.stringify({ workspaceId: "ws_demo" }) } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } },
    ])
    return
  }
  sse(res, [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: `The workspace has this data: ${String(toolMessage.content).slice(0, 200)}` }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 } },
  ])
})

await new Promise((resolve) => mcpHttp.listen(0, "127.0.0.1", resolve))
if (withMockGateway) await new Promise((resolve) => mockGateway.listen(0, "127.0.0.1", resolve))
process.stdout.write(`${JSON.stringify({ mcpPort: mcpHttp.address().port, gatewayPort: withMockGateway ? mockGateway.address().port : null })}\n`)
