import { readFileSync } from "node:fs"
import path from "node:path"
import { bootSandboxFromSnapshot } from "@/lib/agent-sandbox"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"

export class ResearchAgentUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResearchAgentUnavailableError"
  }
}

function readEntryScript(): string {
  return readFileSync(
    path.join(process.cwd(), "scripts/agent/research-interview-entry.ts"),
    "utf8",
  )
}

export async function runResearchInterviewAgent({
  prompt,
  attachments = [],
  onDelta,
}: {
  prompt: string
  baseUrl: string
  attachments?: Array<{ mimeType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; originalName: string; bytes: Uint8Array }>
  onDelta?: (text: string) => void
}): Promise<string> {
  const snapshotId = await getGoldenSnapshotId()
  if (!snapshotId) {
    throw new ResearchAgentUnavailableError("Agent runtime is not initialized")
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    throw new ResearchAgentUnavailableError("ANTHROPIC_API_KEY is not configured")
  }

  let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>> | undefined
  try {
    sandbox = await bootSandboxFromSnapshot(snapshotId)
    if (attachments.length > 3 || attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0) > 15 * 1024 * 1024) {
      throw new Error("Research multimodal input exceeded its bounded attachment limit")
    }
    const payload = {
      prompt,
      attachments: attachments.map((attachment) => ({
        mimeType: attachment.mimeType,
        originalName: attachment.originalName,
        data: Buffer.from(attachment.bytes).toString("base64"),
      })),
    }
    await sandbox.writeFiles([
      { path: "entry.ts", content: readEntryScript() },
      { path: "prompt.json", content: JSON.stringify(payload) },
    ])
    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["entry.ts"],
      env: {
        ANTHROPIC_API_KEY: anthropicApiKey,
      },
      detached: true,
      timeoutMs: 2 * 60_000,
    })

    let buffer = ""
    let responseText: string | undefined
    let agentError: string | undefined
    let provisionalChars = 0
    for await (const log of run.logs()) {
      if (log.stream !== "stdout") continue
      buffer += log.data
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const separator = line.indexOf(" ")
        const kind = separator === -1 ? line : line.slice(0, separator)
        const payload = separator === -1 ? "" : line.slice(separator + 1)
        if (kind === "AGENT_DELTA") {
          const text = (JSON.parse(payload) as { text?: unknown }).text
          if (typeof text !== "string" || (onDelta && provisionalChars + text.length > 4_000)) {
            throw new Error("Research provisional response exceeded its limit")
          }
          provisionalChars += text.length
          onDelta?.(text)
        } else if (kind === "AGENT_RESULT") {
          responseText = (JSON.parse(payload) as { text?: string }).text
        } else if (kind === "AGENT_ERROR") {
          agentError = (JSON.parse(payload) as { message?: string }).message
        }
      }
      if (buffer.length > 64 * 1024) throw new Error("Research agent frame exceeded its limit")
    }

    const result = await run.wait()
    if (result.exitCode !== 0 || !responseText?.trim()) {
      throw new Error(agentError || `Research agent exited with code ${result.exitCode}`)
    }
    return responseText.trim()
  } finally {
    if (sandbox) {
      try {
        await sandbox.stop()
      } catch {
        // Best-effort sandbox cleanup; this public path carries no MCP credential.
      }
    }
  }
}
