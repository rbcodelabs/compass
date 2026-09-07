import { query } from "@anthropic-ai/claude-agent-sdk"
import { readFileSync } from "node:fs"

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Missing analysis credential")
  const { prompt } = JSON.parse(readFileSync("prompt.json", "utf8")) as { prompt: string }
  let text: string | undefined
  for await (const message of query({ prompt, options: { model: "claude-sonnet-5", tools: [], maxTurns: 1 } })) {
    if (message.type !== "result") continue
    if (message.subtype !== "success") throw new Error("Analysis failed")
    text = message.result
  }
  if (!text?.trim() || text.length > 100_000) throw new Error("Invalid analysis output")
  process.stdout.write(`ANALYSIS_RESULT ${JSON.stringify({ text })}\n`)
}
main().catch(() => { process.stdout.write("ANALYSIS_ERROR\n"); process.exitCode = 1 })
