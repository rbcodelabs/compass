import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("UI system workflow integration", () => {
  it("declares each required authentication gate exactly once", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"))
    const jobIds = [...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1])
    expect(jobIds).toEqual([...new Set(jobIds)])
    expect(jobIds).toEqual(expect.arrayContaining(["checks", "authenticated-roadmap", "authenticated-capture"]))
  })
})
