// Public research-interview agent entry point. Public participant text is sent
// to the model with no Compass MCP server or workspace credential attached.

import { query } from "@anthropic-ai/claude-agent-sdk"

function emit(kind: "AGENT_RESULT" | "AGENT_ERROR", payload: unknown): void {
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function main(): Promise<void> {
  const prompt = requireEnv("AGENT_PROMPT")
  requireEnv("ANTHROPIC_API_KEY")

  let finalText: string | undefined
  let usage: unknown
  for await (const message of query({
    prompt,
    options: {
      model: "claude-sonnet-5",
      tools: [],
      maxTurns: 1,
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
