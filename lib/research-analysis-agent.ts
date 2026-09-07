import { readFileSync } from "node:fs"
import path from "node:path"
import { Sandbox } from "@vercel/sandbox"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { analysisOperationMs, analysisStep, assertAnalysisDeadline } from "@/lib/research-analysis-deadline"

async function stopAnalysisSandbox(sandbox: Sandbox) {
  const controller = new AbortController()
  try {
    await analysisStep(() => sandbox.stop({ signal: controller.signal }), Date.now() + 5_000, controller)
  } catch { console.error("Research analysis sandbox cleanup failed") }
}

/** Tool-free research analysis. No MCP server, cookies, or workspace credentials. */
export async function runResearchAnalysisAgent(prompt: string, deadline = Date.now() + analysisOperationMs): Promise<string> {
  const controller = new AbortController()
  const step = <T>(start: () => Promise<T>) => analysisStep(start, deadline, controller)
  const snapshotId = await step(getGoldenSnapshotId)
  const key = process.env.ANTHROPIC_API_KEY
  if (!snapshotId || !key) throw new Error("Research analysis runtime unavailable")
  if (prompt.length > 510_000) throw new Error("Analysis input too large")
  let sandbox: Sandbox | undefined
  try {
    sandbox = await analysisStep(() => Sandbox.create({ source: { type: "snapshot", snapshotId }, timeout: Math.max(1, deadline - Date.now()), signal: controller.signal }), deadline, controller, stopAnalysisSandbox)
    const active = sandbox
    await step(() => active.writeFiles([
      { path: "entry.ts", content: readFileSync(path.join(process.cwd(), "scripts/agent/research-analysis-entry.ts"), "utf8") },
      { path: "prompt.json", content: JSON.stringify({ prompt, deadline }) },
    ], { signal: controller.signal }))
    const command = await step(() => active.runCommand({ cmd: "node", args: ["entry.ts"], env: { ANTHROPIC_API_KEY: key }, detached: true, timeoutMs: Math.max(1, Math.min(120_000, deadline - Date.now())), signal: controller.signal }))
    let output = ""
    const logs = command.logs({ signal: controller.signal })[Symbol.asyncIterator]()
    while (true) {
      const next = await step(() => logs.next())
      if (next.done) break
      const log = next.value
      if (log.stream !== "stdout") continue
      output += log.data
      if (output.length > 110_000) throw new Error("Analysis output too large")
    }
    const result = await step(() => command.wait({ signal: controller.signal }))
    const lines = output.trim().split("\n").filter(line => line.startsWith("ANALYSIS_RESULT "))
    if (result.exitCode !== 0 || lines.length !== 1) throw new Error("Analysis did not complete")
    const payload = JSON.parse(lines[0].slice("ANALYSIS_RESULT ".length)) as { text?: unknown }
    if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 100_000) throw new Error("Invalid analysis response")
    assertAnalysisDeadline(deadline)
    return payload.text
  } finally {
    controller.abort()
    if (sandbox) await stopAnalysisSandbox(sandbox)
  }
}
