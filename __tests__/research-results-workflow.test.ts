import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("runs the results journey in the existing authenticated Capture invocation", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
  const captureJob = workflow.split("\n  authenticated-capture:\n")[1]?.split(/^  [a-zA-Z0-9_-]+:\s*$/m)[0]
  expect(captureJob).toBeDefined()
  const commands = captureJob!.split("\n").filter((line) => line.includes("run: pnpm test:e2e:functional"))
  expect(commands).toHaveLength(1)
  expect(commands[0]).toContain("e2e/functional/specs/capture-research.spec.ts")
  expect(commands[0]).toContain("e2e/functional/specs/capture-results.spec.ts")
  expect(commands[0]).toContain("e2e/functional/specs/research-mcp.spec.ts")
})
