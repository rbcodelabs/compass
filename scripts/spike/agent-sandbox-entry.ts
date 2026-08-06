// Spike script — runs INSIDE a @vercel/sandbox microVM, not as part of the
// Next.js app itself. It has its own package.json/node_modules installed at
// sandbox runtime (see app/api/spike/agent-sandbox/route.ts), so it is a
// standalone Node 24 script, not part of this project's module graph.
//
// Purpose: prove that the Claude Agent SDK's query() can run inside a Vercel
// Sandbox and drive ONE custom tool that calls back out to this same Compass
// deployment's existing /api/mcp endpoint (list_workspaces), authenticating
// with the existing service-account MCP_API_KEY. No Prisma/DSQL credentials
// are ever passed into the sandbox — the tool is a thin HTTP client.
//
// Required env vars (passed in by the route via sandbox.runCommand):
//   ANTHROPIC_API_KEY - Claude API key for the Agent SDK
//   MCP_API_KEY       - Compass's existing MCP service-account bearer token
//   MCP_BASE_URL      - Base URL of the Compass deployment to call back into

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"

const MCP_BASE_URL = process.env.MCP_BASE_URL
const MCP_API_KEY = process.env.MCP_API_KEY

if (!MCP_BASE_URL) {
  console.error("[spike-entry] Missing MCP_BASE_URL env var")
  process.exit(1)
}
if (!MCP_API_KEY) {
  console.error("[spike-entry] Missing MCP_API_KEY env var")
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("[spike-entry] Missing ANTHROPIC_API_KEY env var")
  process.exit(1)
}

// Thin HTTP client for Compass's existing MCP Streamable HTTP endpoint.
// Reuses the existing MCP tool catalog (app/api/mcp/route.ts) rather than
// duplicating any query/business logic in the sandbox.
async function callCompassListWorkspaces(orgSlug: string): Promise<string> {
  const transport = new StreamableHTTPClientTransport(
    new URL("/api/mcp", MCP_BASE_URL),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${MCP_API_KEY}` },
      },
    }
  )
  const client = new Client({ name: "agent-sandbox-spike", version: "0.0.1" })
  await client.connect(transport)
  try {
    const result = await client.callTool({
      name: "list_workspaces",
      arguments: { orgSlug },
    })
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
    return text || JSON.stringify(result)
  } finally {
    await client.close()
  }
}

const compassServer = createSdkMcpServer({
  name: "compass",
  version: "0.0.1",
  tools: [
    tool(
      "list_workspaces",
      "Lists all workspaces for an organization in Compass, by org slug. " +
        "Calls back into the Compass deployment's own /api/mcp endpoint.",
      {
        orgSlug: z.string().min(1).describe("The organization slug, e.g. 'rbcodelabs'"),
      },
      async (args) => {
        try {
          const text = await callCompassListWorkspaces(args.orgSlug)
          return { content: [{ type: "text", text }] }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text", text: `Error calling list_workspaces: ${message}` }],
            isError: true,
          }
        }
      }
    ),
  ],
})

async function main() {
  const prompt = "What workspaces exist for org rbcodelabs? Use the list_workspaces tool."
  console.log(`[spike-entry] prompt: ${prompt}`)

  let finalResult: string | undefined
  let usageSummary: string | undefined

  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-5",
      mcpServers: { compass: compassServer },
      allowedTools: ["mcp__compass__list_workspaces"],
      maxTurns: 6,
    },
  })) {
    // Log a compact trace of every message type so the route can stream
    // progress back out, and so latency/turn-count is visible in the report.
    console.log(`[spike-entry:${message.type}]`, JSON.stringify(message).slice(0, 2000))

    if (message.type === "result") {
      if (message.subtype === "success") {
        finalResult = message.result
        usageSummary = JSON.stringify({
          duration_ms: message.duration_ms,
          duration_api_ms: message.duration_api_ms,
          num_turns: message.num_turns,
          total_cost_usd: message.total_cost_usd,
          usage: message.usage,
        })
      } else {
        console.error(`[spike-entry] query() ended with non-success subtype: ${message.subtype}`)
      }
    }
  }

  console.log("=== SPIKE FINAL RESULT ===")
  console.log(finalResult ?? "(no result — query() ended without a success result message)")
  console.log("=== SPIKE USAGE ===")
  console.log(usageSummary ?? "(no usage data)")

  if (!finalResult) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error("[spike-entry] fatal error", err)
  process.exit(1)
})
