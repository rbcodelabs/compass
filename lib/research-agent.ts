import { readFileSync } from "node:fs"
import path from "node:path"
import { bootSandboxFromSnapshot } from "@/lib/agent-sandbox"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { mintResearchAgentMcpKey, revokeAgentMcpKey } from "@/lib/agent-mcp-key"

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
  userId,
  workspaceId,
  prompt,
  baseUrl,
}: {
  userId: string
  workspaceId: string
  prompt: string
  baseUrl: string
}): Promise<string> {
  const snapshotId = await getGoldenSnapshotId()
  if (!snapshotId) {
    throw new ResearchAgentUnavailableError("Agent runtime is not initialized")
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    throw new ResearchAgentUnavailableError("ANTHROPIC_API_KEY is not configured")
  }

  const { token, apiKeyId } = await mintResearchAgentMcpKey(userId, workspaceId)
  let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>> | undefined
  try {
    sandbox = await bootSandboxFromSnapshot(snapshotId)
    await sandbox.writeFiles([{ path: "entry.ts", content: readEntryScript() }])
    const run = await sandbox.runCommand({
      cmd: "node",
      args: ["entry.ts"],
      env: {
        ANTHROPIC_API_KEY: anthropicApiKey,
        MCP_BASE_URL: baseUrl,
        MCP_TOKEN: token,
        AGENT_PROMPT: prompt,
        ...(process.env.MCP_BYPASS_SECRET
          ? { MCP_BYPASS_SECRET: process.env.MCP_BYPASS_SECRET }
          : {}),
      },
      detached: true,
      timeoutMs: 2 * 60_000,
    })

    let buffer = ""
    let responseText: string | undefined
    let agentError: string | undefined
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
        if (kind === "AGENT_RESULT") {
          responseText = (JSON.parse(payload) as { text?: string }).text
        } else if (kind === "AGENT_ERROR") {
          agentError = (JSON.parse(payload) as { message?: string }).message
        }
      }
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
        // Best-effort cleanup; the MCP credential is still revoked below.
      }
    }
    await revokeAgentMcpKey(apiKeyId)
  }
}
