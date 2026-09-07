import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("UI system workflow integration", () => {
  it("runs mocked browser voice alongside Capture in the existing authenticated job", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
    const capture = workflow.split("  authenticated-capture:")[1].split("\n  screenshots:")[0]
    expect(capture).toContain("e2e/functional/specs/capture-research.spec.ts e2e/functional/specs/research-browser-voice.spec.ts")
    expect(capture).toContain('COMPASS_RESEARCH_BROWSER_VOICE_ENABLED: "1"')
  })
  it("declares each required authentication gate exactly once", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"))
    const jobIds = [...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1])
    expect(jobIds).toEqual([...new Set(jobIds)])
    expect(jobIds).toEqual(expect.arrayContaining(["checks", "authenticated-roadmap", "authenticated-capture"]))
  })
})
