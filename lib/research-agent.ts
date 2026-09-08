import { readFileSync } from "node:fs"
import path from "node:path"
import { bootSandboxFromSnapshot } from "@/lib/agent-sandbox"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { Sandbox } from "@vercel/sandbox"
import { analysisStep, assertAnalysisDeadline } from "@/lib/research-analysis-deadline"

async function stopBoundedSandbox(sandbox: Sandbox) {
  const controller = new AbortController()
  try { await analysisStep(() => sandbox.stop({ signal: controller.signal }), Date.now() + 5_000, controller) }
  catch { console.error("Research guide sandbox cleanup failed") }
}

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
  deadline,
}: {
  prompt: string
  baseUrl: string
  attachments?: Array<{ mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "application/pdf"; originalName: string; bytes: Uint8Array }>
  onDelta?: (text: string) => void
  /** Optional absolute deadline for bounded callers such as MCP guide generation. */
  deadline?: number
}): Promise<string> {
  const controller = new AbortController()
  const step = <T>(start: () => Promise<T>) => deadline === undefined ? start() : analysisStep(start, deadline, controller)
  const snapshotId = await step(getGoldenSnapshotId)
  if (!snapshotId) {
    throw new ResearchAgentUnavailableError("Agent runtime is not initialized")
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    throw new ResearchAgentUnavailableError("ANTHROPIC_API_KEY is not configured")
  }

  let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>> | undefined
  try {
    sandbox = deadline === undefined ? await bootSandboxFromSnapshot(snapshotId) : await analysisStep(() => Sandbox.create({ source: { type: "snapshot", snapshotId }, timeout: Math.max(1, deadline - Date.now()), signal: controller.signal }), deadline, controller, stopBoundedSandbox)
    const active = sandbox
    if (attachments.length > 3 || attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0) > 15 * 1024 * 1024) {
      throw new Error("Research multimodal input exceeded its bounded attachment limit")
    }
    const payload = {
      prompt,
      ...(deadline === undefined ? {} : { deadline }),
      attachments: attachments.map((attachment) => ({
        mimeType: attachment.mimeType,
        originalName: attachment.originalName,
        data: Buffer.from(attachment.bytes).toString("base64"),
      })),
    }
    await step(() => active.writeFiles([
      { path: "entry.ts", content: readEntryScript() },
      { path: "prompt.json", content: JSON.stringify(payload) },
    ], deadline === undefined ? undefined : { signal: controller.signal }))
    const run = await step(() => active.runCommand({
      cmd: "node",
      args: ["entry.ts"],
      env: {
        ANTHROPIC_API_KEY: anthropicApiKey,
      },
      detached: true,
      timeoutMs: deadline === undefined ? 2 * 60_000 : Math.max(1, Math.min(120_000, deadline - Date.now())),
      ...(deadline === undefined ? {} : { signal: controller.signal }),
    }))

    let buffer = ""
    let responseText: string | undefined
    let agentError: string | undefined
    let provisionalChars = 0
    const logs = run.logs(deadline === undefined ? undefined : { signal: controller.signal })
    async function* boundedLogs() {
      const iterator = logs[Symbol.asyncIterator]()
      while (true) {
        const next = await step(() => iterator.next())
        if (next.done) return
        yield next.value
      }
    }
    for await (const log of deadline === undefined ? logs : boundedLogs()) {
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

    const result = await step(() => run.wait(deadline === undefined ? undefined : { signal: controller.signal }))
    if (result.exitCode !== 0 || !responseText?.trim()) {
      throw new Error(agentError || `Research agent exited with code ${result.exitCode}`)
    }
    if (deadline !== undefined) assertAnalysisDeadline(deadline)
    return responseText.trim()
  } finally {
    controller.abort()
    if (sandbox) {
      try {
        if (deadline === undefined) await sandbox.stop()
        else await stopBoundedSandbox(sandbox)
      } catch {
        // Best-effort sandbox cleanup; this public path carries no MCP credential.
      }
    }
  }
}
