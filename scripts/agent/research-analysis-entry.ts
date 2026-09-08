import { query } from "@anthropic-ai/claude-agent-sdk"
import { readFileSync } from "node:fs"

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing analysis credential")
  const { prompt, deadline } = JSON.parse(readFileSync("prompt.json", "utf8")) as { prompt: string; deadline: number }
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error("Analysis deadline exceeded")
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), deadline - Date.now())
  let text: string | undefined
  try {
    for await (const message of query({ prompt, options: { model: "claude-sonnet-5", tools: [], maxTurns: 1, abortController } })) {
      if (message.type !== "result") continue
      if (message.subtype !== "success") throw new Error("Analysis failed")
      text = message.result
    }
    if (Date.now() >= deadline || !text?.trim() || text.length > 100_000) throw new Error("Invalid analysis output")
    process.stdout.write(`ANALYSIS_RESULT ${JSON.stringify({ text })}\n`)
  } finally { clearTimeout(timer); abortController.abort() }
}
main().catch(() => { process.stdout.write("ANALYSIS_ERROR\n"); process.exitCode = 1 })
