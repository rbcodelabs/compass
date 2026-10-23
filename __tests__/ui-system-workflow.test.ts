import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("UI system workflow integration", () => {
  it("runs private GIF and HEIC original roundtrips with the other Capture journeys", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
    const capture = workflow.split("  authenticated-capture:")[1].split("\n  screenshots:")[0]
    expect(capture).toContain("e2e/functional/specs/capture-attachment-formats.spec.ts")
    expect(capture).toContain("e2e/functional/specs/capture-results.spec.ts")
  })
  it("runs mocked browser voice alongside Capture in the existing authenticated job", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
    const capture = workflow.split("  authenticated-capture:")[1].split("\n  screenshots:")[0]
    expect(capture).toContain("e2e/functional/specs/capture-research.spec.ts e2e/functional/specs/research-browser-voice.spec.ts")
    // Browser voice is a workspace module now: the functional seed enables every module, not a workflow environment variable.
    expect(capture).not.toContain("COMPASS_RESEARCH_BROWSER_VOICE_ENABLED")
    const seed = readFileSync(new URL("../e2e/functional/fixtures/seed-e2e.ts", import.meta.url), "utf8")
    expect(seed).toContain("for (const key of MODULE_KEYS)")
  })
  it("declares each required authentication gate exactly once", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ui-system.yml", import.meta.url), "utf8")
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n"))
    const jobIds = [...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map((match) => match[1])
    expect(jobIds).toEqual([...new Set(jobIds)])
    expect(jobIds).toEqual(expect.arrayContaining(["checks", "authenticated-roadmap", "authenticated-capture"]))
  })
})
