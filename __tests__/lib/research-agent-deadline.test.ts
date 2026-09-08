import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const m = vi.hoisted(() => ({ create: vi.fn(), write: vi.fn(), run: vi.fn(), stop: vi.fn() }))
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: m.create } }))
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot: m.create }))
vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId: async () => "snapshot" }))
import { runResearchInterviewAgent } from "@/lib/research-agent"
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.stubEnv("ANTHROPIC_API_KEY", "test-key")
  m.create.mockResolvedValue({ writeFiles: m.write, runCommand: m.run, stop: m.stop })
  m.write.mockResolvedValue(undefined); m.stop.mockResolvedValue(undefined)
  m.run.mockResolvedValue({ logs: async function* () { yield { stream: "stdout", data: 'AGENT_RESULT {"text":"Guide"}\n' } }, wait: async () => ({ exitCode: 0 }) })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
const run = () => runResearchInterviewAgent({ prompt: "Guide", baseUrl: "https://example.test", deadline: Date.now() + 100 })
describe("bounded MCP guide runtime", () => {
  it("cleans a late allocation without dispatching a model command", async () => {
    let resolve!: (value: unknown) => void
    m.create.mockImplementation(() => new Promise(done => { resolve = done }))
    const assertion = expect(run()).rejects.toThrow(/deadline/)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    resolve({ writeFiles: m.write, runCommand: m.run, stop: m.stop })
    await vi.advanceTimersByTimeAsync(0)
    expect(m.stop).toHaveBeenCalledTimes(1)
    expect(m.run).not.toHaveBeenCalled()
  })
  it("does not dispatch after a stalled upload expires", async () => {
    m.write.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 200)))
    const assertion = expect(run()).rejects.toThrow(/deadline/)
    await vi.advanceTimersByTimeAsync(200)
    await assertion
    expect(m.run).not.toHaveBeenCalled()
    expect(m.stop).toHaveBeenCalledTimes(1)
  })
  it("bounds stalled logs and cleanup", async () => {
    m.run.mockResolvedValue({ logs: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) })
    m.stop.mockImplementation(() => new Promise(() => {}))
    const assertion = expect(run()).rejects.toThrow(/deadline/)
    await vi.advanceTimersByTimeAsync(5_101)
    await assertion
    expect(m.stop).toHaveBeenCalledTimes(1)
  })
  it("passes the absolute deadline into the worker and bounds provider execution", async () => {
    expect(await run()).toBe("Guide")
    const payload = m.write.mock.calls[0][0].find((file: { path: string }) => file.path === "prompt.json")
    expect(JSON.parse(payload.content).deadline).toBe(Date.now() + 100)
    expect(m.run.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(100)
  })
})
