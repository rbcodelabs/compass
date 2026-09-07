import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), boot: vi.fn(), write: vi.fn(), run: vi.fn(), stop: vi.fn() }))
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot: mocks.boot }))
vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: mocks.snapshot }))
import { runResearchAnalysisAgent } from "@/lib/research-analysis-agent"
import { readFileSync } from "node:fs"
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ANTHROPIC_API_KEY", "test-key")
  mocks.snapshot.mockResolvedValue("snapshot"); mocks.boot.mockResolvedValue({ writeFiles: mocks.write, runCommand: mocks.run, stop: mocks.stop }); mocks.stop.mockResolvedValue(undefined)
  mocks.run.mockResolvedValue({ logs: async function* () { yield { stream: "stdout", data: 'ANALYSIS_RESULT {"text":"{}"}\n' } }, wait: async () => ({ exitCode: 0 }) })
})
afterEach(() => vi.unstubAllEnvs())
describe("tool-free analysis runtime", () => {
  it("passes no workspace/MCP credentials and stops the sandbox", async () => {
    expect(await runResearchAnalysisAgent("untrusted transcript")).toBe("{}")
    expect(mocks.run.mock.calls[0][0].env).toEqual({ ANTHROPIC_API_KEY: "test-key" })
    expect(mocks.stop).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mocks.write.mock.calls)).not.toContain("test-key")
    const entry = readFileSync("scripts/agent/research-analysis-entry.ts", "utf8")
    expect(entry).toContain("tools: []")
    expect(entry).toContain("maxTurns: 1")
    expect(entry).not.toContain("mcpServers")
  })
  it("rejects excess output and cleans up", async () => {
    mocks.run.mockResolvedValue({ logs: async function* () { yield { stream: "stdout", data: "x".repeat(110_001) } } })
    await expect(runResearchAnalysisAgent("prompt")).rejects.toThrow(/too large/)
    expect(mocks.stop).toHaveBeenCalledTimes(1)
  })
  it("does not allocate without initialized credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    await expect(runResearchAnalysisAgent("prompt")).rejects.toThrow(/unavailable/)
    expect(mocks.boot).not.toHaveBeenCalled()
  })
})
