import { beforeEach, describe, expect, it, vi } from "vitest"

const getGoldenSnapshotId = vi.hoisted(() => vi.fn())
const bootSandboxFromSnapshot = vi.hoisted(() => vi.fn())
const mintResearchAgentMcpKey = vi.hoisted(() => vi.fn())
const revokeAgentMcpKey = vi.hoisted(() => vi.fn())

vi.mock("@/lib/agent-runtime-config", () => ({ getGoldenSnapshotId }))
vi.mock("@/lib/agent-sandbox", () => ({ bootSandboxFromSnapshot }))
vi.mock("@/lib/agent-mcp-key", () => ({ mintResearchAgentMcpKey, revokeAgentMcpKey }))

import { ResearchAgentUnavailableError, runResearchInterviewAgent } from "@/lib/research-agent"

describe("runResearchInterviewAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key"
    getGoldenSnapshotId.mockResolvedValue("snapshot-1")
    mintResearchAgentMcpKey.mockResolvedValue({ token: "cmp_token", apiKeyId: "key-1" })
  })

  it("runs in the shared sandbox and always revokes its workspace-scoped key", async () => {
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
      userId: "user-1",
      workspaceId: "workspace-1",
      prompt: "Interview prompt",
      baseUrl: "https://compass.example",
    })).resolves.toBe("What happened next?")

    expect(mintResearchAgentMcpKey).toHaveBeenCalledWith("user-1", "workspace-1")
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ MCP_TOKEN: "cmp_token", AGENT_PROMPT: "Interview prompt" }),
    }))
    expect(stop).toHaveBeenCalled()
    expect(revokeAgentMcpKey).toHaveBeenCalledWith("key-1")
  })

  it("fails before minting a credential when the shared agent runtime is unavailable", async () => {
    getGoldenSnapshotId.mockResolvedValue(null)

    await expect(runResearchInterviewAgent({
      userId: "user-1",
      workspaceId: "workspace-1",
      prompt: "Interview prompt",
      baseUrl: "https://compass.example",
    })).rejects.toBeInstanceOf(ResearchAgentUnavailableError)
    expect(mintResearchAgentMcpKey).not.toHaveBeenCalled()
  })
})
