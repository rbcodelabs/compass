import { readFileSync } from "node:fs"
import path from "node:path"
import { bootSandboxFromSnapshot } from "@/lib/agent-sandbox"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"

/** Tool-free research analysis. No MCP server, cookies, or workspace credentials. */
export async function runResearchAnalysisAgent(prompt: string): Promise<string> {
  const snapshotId = await getGoldenSnapshotId()
  const key = process.env.ANTHROPIC_API_KEY
  if (!snapshotId || !key) throw new Error("Research analysis runtime unavailable")
  if (prompt.length > 510_000) throw new Error("Analysis input too large")
  let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>> | undefined
  try {
    sandbox = await bootSandboxFromSnapshot(snapshotId)
    await sandbox.writeFiles([
      { path: "entry.ts", content: readFileSync(path.join(process.cwd(), "scripts/agent/research-analysis-entry.ts"), "utf8") },
      { path: "prompt.json", content: JSON.stringify({ prompt }) },
    ])
    const command = await sandbox.runCommand({ cmd: "node", args: ["entry.ts"], env: { ANTHROPIC_API_KEY: key }, detached: true, timeoutMs: 120_000 })
    let output = ""
    for await (const log of command.logs()) {
      if (log.stream !== "stdout") continue
      output += log.data
      if (output.length > 110_000) throw new Error("Analysis output too large")
    }
    const result = await command.wait()
    const lines = output.trim().split("\n").filter(line => line.startsWith("ANALYSIS_RESULT "))
    if (result.exitCode !== 0 || lines.length !== 1) throw new Error("Analysis did not complete")
    const payload = JSON.parse(lines[0].slice("ANALYSIS_RESULT ".length)) as { text?: unknown }
    if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 100_000) throw new Error("Invalid analysis response")
    return payload.text
  } finally {
    if (sandbox) await sandbox.stop().catch(() => { console.error("Research analysis sandbox cleanup failed") })
  }
}
