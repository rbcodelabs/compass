// Public research-interview agent entry point. Runs inside the same warm
// Vercel Sandbox runtime as Compass's in-app agent, but receives a short-lived
// workspace-scoped MCP credential and an exact read-only tool allowlist.

import { query } from "@anthropic-ai/claude-agent-sdk"

const READ_ONLY_RESEARCH_TOOLS = [
  "mcp__compass__get_workspace_summary",
  "mcp__compass__list_feedback",
  "mcp__compass__list_docs",
  "mcp__compass__get_doc",
  "mcp__compass__list_opportunities",
  "mcp__compass__get_opportunity",
]

function emit(kind: "AGENT_RESULT" | "AGENT_ERROR", payload: unknown): void {
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("MCP_BASE_URL")
  const token = requireEnv("MCP_TOKEN")
  const prompt = requireEnv("AGENT_PROMPT")
  requireEnv("ANTHROPIC_API_KEY")

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (process.env.MCP_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = process.env.MCP_BYPASS_SECRET
  }

  let finalText: string | undefined
  let usage: unknown
  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-5",
      mcpServers: {
        compass: {
          type: "http",
          url: new URL("/api/mcp", baseUrl).toString(),
          headers,
          alwaysLoad: true,
        },
      },
      allowedTools: READ_ONLY_RESEARCH_TOOLS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 8,
    },
  })) {
    if (message.type !== "result") continue
    if (message.subtype !== "success") {
      throw new Error(`Research query ended with subtype: ${message.subtype}`)
    }
    finalText = message.result
    usage = {
      durationMs: message.duration_ms,
      durationApiMs: message.duration_api_ms,
      numTurns: message.num_turns,
      totalCostUsd: message.total_cost_usd,
      usage: message.usage,
    }
  }

  if (!finalText?.trim()) throw new Error("Research query ended without a response")
  emit("AGENT_RESULT", { text: finalText.trim(), usage })
}

main().catch((error: unknown) => {
  emit("AGENT_ERROR", { message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
