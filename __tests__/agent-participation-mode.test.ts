import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  defaultAgentModeForVisibility,
  isAgentParticipationMode,
  messageMentionsAgent,
  normalizeAgentParticipationMode,
  shouldInvokeAgentOnTurn,
} from "@/lib/agent-participation-mode"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockPrisma = {
  workspace: { findFirst: vi.fn() },
  agentConversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  agentMessage: { create: vi.fn() },
  agentConversationParticipant: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const mockGetGoldenSnapshotId = vi.fn()
vi.mock("@/lib/agent-runtime-config", () => ({
  getGoldenSnapshotId: () => mockGetGoldenSnapshotId(),
}))

const mockBootSandbox = vi.fn()
vi.mock("@/lib/agent-sandbox", () => ({
  bootSandboxFromSnapshot: (...args: unknown[]) => mockBootSandbox(...args),
}))

vi.mock("@/lib/agent-run-identity", async (original) => ({
  ...(await original<object>()),
  resolveRunAgent: vi.fn().mockResolvedValue(null),
}))

import { POST } from "@/app/api/agent/turn/route"

describe("agent-participation-mode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
    mockPrisma.workspace.findFirst.mockResolvedValue({
      id: "ws-1",
      name: "Compass",
      slug: "compass",
      organization: { slug: "rbcodelabs" },
    })
    mockPrisma.agentConversation.create.mockResolvedValue({ id: "conv-passive-1" })
    mockPrisma.agentMessage.create.mockResolvedValue({ id: "msg-passive-1" })
    mockPrisma.agentConversationParticipant.findFirst.mockResolvedValue({ id: "p-1" })
  })

  it("defaults PRIVATE chats to AUTO and WORKSPACE or object-anchored threads to MENTION_ONLY", () => {
    expect(defaultAgentModeForVisibility("PRIVATE", false)).toBe("AUTO")
    expect(defaultAgentModeForVisibility(null, false)).toBe("AUTO")
    expect(defaultAgentModeForVisibility("WORKSPACE", false)).toBe("MENTION_ONLY")
    expect(defaultAgentModeForVisibility("PRIVATE", true)).toBe("MENTION_ONLY")
  })

  it("validates and normalizes agent participation modes", () => {
    expect(isAgentParticipationMode("AUTO")).toBe(true)
    expect(isAgentParticipationMode("MENTION_ONLY")).toBe(true)
    expect(isAgentParticipationMode("NONE")).toBe(true)
    expect(isAgentParticipationMode("INVALID")).toBe(false)
    expect(normalizeAgentParticipationMode("MENTION_ONLY")).toBe("MENTION_ONLY")
    expect(normalizeAgentParticipationMode(null, "MENTION_ONLY")).toBe("MENTION_ONLY")
  })

  it("detects @Compass Agent, @agent, custom @<agentName>, and structured agent mention tokens", () => {
    expect(messageMentionsAgent("Hey @Compass Agent can you summarize this?")).toBe(true)
    expect(messageMentionsAgent("@agent please check the RICE score")).toBe(true)
    expect(messageMentionsAgent("Ask @Discovery Bot for input", "Discovery Bot")).toBe(true)
    expect(
      messageMentionsAgent(
        "@[Compass Agent](mention:agent:00000000-0000-4000-8000-000000000001) please review",
      ),
    ).toBe(true)
    expect(
      messageMentionsAgent(
        "@[Quinn Morales](mention:user:00000000-0000-4000-8000-000000000002) what do you think?",
      ),
    ).toBe(false)
    expect(messageMentionsAgent("Just a human note for @sarah")).toBe(false)
    expect(messageMentionsAgent("email user@agent.com is not a mention")).toBe(false)
  })

  it("decides whether a turn invokes the agent based on agentMode and @mentions", () => {
    expect(shouldInvokeAgentOnTurn({ agentMode: "AUTO", message: "Plain message" })).toBe(true)
    expect(shouldInvokeAgentOnTurn({ agentMode: "NONE", message: "@Compass Agent hi" })).toBe(false)
    expect(shouldInvokeAgentOnTurn({ agentMode: "MENTION_ONLY", message: "Plain human reply" })).toBe(false)
    expect(
      shouldInvokeAgentOnTurn({
        agentMode: "MENTION_ONLY",
        message: "@Compass Agent what do you think?",
      }),
    ).toBe(true)
  })

  it("persists a passive human turn in POST /api/agent/turn without booting a sandbox when agentMode is MENTION_ONLY and no @mention is present", async () => {
    const req = new NextRequest("https://compass.rbcodelabs.com/api/agent/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws-1",
        message: "Team note: let's verify the migration before merging.",
        agentMode: "MENTION_ONLY",
        visibility: "WORKSPACE",
        targetType: "OPPORTUNITY",
        targetId: "4f4390a6-f4ea-44ae-88b8-f19212ab0189",
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      passive?: boolean
      conversationId?: string
      messageId?: string
      agentMode?: string
    }
    expect(payload).toEqual({
      passive: true,
      conversationId: "conv-passive-1",
      messageId: "msg-passive-1",
      agentMode: "MENTION_ONLY",
    })
    expect(mockGetGoldenSnapshotId).not.toHaveBeenCalled()
    expect(mockBootSandbox).not.toHaveBeenCalled()
    expect(mockPrisma.agentConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          userId: "user-1",
          targetType: "OPPORTUNITY",
          targetId: "4f4390a6-f4ea-44ae-88b8-f19212ab0189",
          visibility: "WORKSPACE",
          agentMode: "MENTION_ONLY",
        }),
      }),
    )
    expect(mockPrisma.agentMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-passive-1",
          role: "user",
          content: "Team note: let's verify the migration before merging.",
        }),
      }),
    )
  })
})
