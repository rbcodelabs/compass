// Public research-interview agent entry point. Public participant text is sent
// to the model with no Compass MCP server or workspace credential attached.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { readFileSync } from "node:fs"

function emit(kind: "AGENT_DELTA" | "AGENT_RESULT" | "AGENT_ERROR", payload: unknown): void {
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function main(): Promise<void> {
  requireEnv("ANTHROPIC_API_KEY")
  const input = JSON.parse(readFileSync("prompt.json", "utf8")) as {
    prompt: string
    deadline?: number
    attachments: Array<{ mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf"; originalName: string; data: string }>
  }
  const content: Exclude<SDKUserMessage["message"]["content"], string> = [{ type: "text", text: input.prompt }]
  for (const attachment of input.attachments) {
    if (attachment.mimeType === "application/pdf") {
      content.push({
        type: "document",
        title: attachment.originalName,
        citations: { enabled: false },
        source: { type: "base64", media_type: "application/pdf", data: attachment.data },
      })
    } else {
      if (attachment.mimeType === "image/gif") content.push({ type: "text", text: "This GIF supplies only its first frame. Do not infer or claim to observe its animation." })
      content.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
      })
    }
  }
  async function* promptStream(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
    }
  }

  let finalText: string | undefined
  let usage: unknown
  if (input.deadline !== undefined && (!Number.isFinite(input.deadline) || Date.now() >= input.deadline)) throw new Error("Research guide deadline exceeded")
  const abortController = new AbortController()
  const timer = input.deadline === undefined ? undefined : setTimeout(() => abortController.abort(), input.deadline - Date.now())
  try {
    for await (const message of query({
      prompt: input.attachments.length > 0 ? promptStream() : input.prompt,
      options: {
        model: "claude-sonnet-5",
        tools: [],
        maxTurns: 1,
        includePartialMessages: true,
        ...(input.deadline === undefined ? {} : { abortController }),
      },
    })) {
      if (message.type === "stream_event" && message.parent_tool_use_id === null &&
          message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
        emit("AGENT_DELTA", { text: message.event.delta.text })
      }
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

    if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error("Research guide deadline exceeded")
    if (!finalText?.trim()) throw new Error("Research query ended without a response")
    emit("AGENT_RESULT", { text: finalText.trim(), usage })
  } finally { if (timer !== undefined) { clearTimeout(timer); abortController.abort() } }
}

main().catch((error: unknown) => {
  emit("AGENT_ERROR", { message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
