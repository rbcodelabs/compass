import { beforeEach, describe, expect, it, vi } from "vitest"

const getGoldenSnapshotId = vi.hoisted(() => vi.fn())
const bootSandboxFromSnapshot = vi.hoisted(() => vi.fn())

vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId }))
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot }))

import { ResearchAgentUnavailableError, runResearchInterviewAgent } from "@/lib/research-agent"

describe("runResearchInterviewAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
    getGoldenSnapshotId.mockResolvedValue("snapshot-1")
  })

  it("runs in the shared sandbox without internal Compass credentials or tools", async () => {
    async function* logs() {
      yield {
        stream: "stdout",
        data: 'AGENT_RESULT {"text":"What happened next?"}\n',
      }
    }
    const wait = vi.fn().mockResolvedValue({ exitCode: 0 })
    const stop = vi.fn().mockResolvedValue(undefined)
    const runCommand = vi.fn().mockResolvedValue({ logs, wait })
    const writeFiles = vi.fn().mockResolvedValue(undefined)
    bootSandboxFromSnapshot.mockResolvedValue({ writeFiles, runCommand, stop })

    await expect(runResearchInterviewAgent({
      prompt: "Interview prompt",
      baseUrl: "https://compass.example",
    })).resolves.toBe("What happened next?")

    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ AGENT_PROMPT: "Interview prompt" }),
    }))
    const env = runCommand.mock.calls[0][0].env
    expect(env).not.toHaveProperty("MCP_TOKEN")
    expect(env).not.toHaveProperty("MCP_BASE_URL")
    const entry = writeFiles.mock.calls[0][0][0].content as string
    expect(entry).toContain("tools: []")
    expect(entry).not.toContain("allowedTools")
    expect(entry).not.toContain("mcpServers")
    expect(entry).not.toContain("list_feedback")
    expect(entry).not.toContain("get_doc")
    expect(stop).toHaveBeenCalled()
  })

  it("fails before minting a credential when the shared agent runtime is unavailable", async () => {
    getGoldenSnapshotId.mockResolvedValue(null)

    await expect(runResearchInterviewAgent({
      prompt: "Interview prompt",
      baseUrl: "https://compass.example",
    })).rejects.toBeInstanceOf(ResearchAgentUnavailableError)
  })
})
