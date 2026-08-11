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
//
// Output contract (one JSON object per line, prefixed):
//   AGENT_EVENT <json>   — each SDK stream message (assistant/tool/system)
//   AGENT_RESULT <json>  — final { text, usage } on success
//   AGENT_ERROR <json>   — { message } on failure

import { query } from "@anthropic-ai/claude-agent-sdk"

const MCP_BASE_URL = process.env.MCP_BASE_URL
const MCP_TOKEN = process.env.MCP_TOKEN
const AGENT_PROMPT = process.env.AGENT_PROMPT
const MCP_BYPASS_SECRET = process.env.MCP_BYPASS_SECRET

function emit(kind: "AGENT_EVENT" | "AGENT_RESULT" | "AGENT_ERROR", payload: unknown): void {
  // Single line so the host can split stdout on newlines and forward as SSE.
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    emit("AGENT_ERROR", { message: `Missing required env var: ${name}` })
    process.exit(1)
  }
  return value
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("MCP_BASE_URL", MCP_BASE_URL)
  const token = requireEnv("MCP_TOKEN", MCP_TOKEN)
  const prompt = requireEnv("AGENT_PROMPT", AGENT_PROMPT)
  requireEnv("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY)

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (MCP_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = MCP_BYPASS_SECRET

  let finalText: string | undefined
  let usage: unknown

  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-5",
      // Compass's own MCP catalog, reached AS the acting user.
      mcpServers: {
        compass: {
          type: "http",
          url: new URL("/api/mcp", baseUrl).toString(),
          headers,
          // Load the full Compass catalog into the prompt up front instead of
          // deferring it behind ToolSearch. Without this the agent burns turns
          // searching for tools; with it, it can act directly.
          alwaysLoad: true,
        },
      },
      // Compass tools only, auto-approved. Headless (no human approver): the
      // real security boundary is the disposable sandbox + per-user MCP auth.
      allowedTools: ["mcp__compass"],
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
