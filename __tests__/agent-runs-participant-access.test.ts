/**
 * Who may see, stop and be charged for an agent run once a conversation is shared
 *. The run belongs to the person who started it; everyone with
 * access to the conversation may watch it; only that person or the owner may stop it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

import { resetAgentParticipantsAvailabilityCache } from "@/lib/agent-conversation-participants"
import { AgentRunError, cancelAgentRun, finalizeAgentRun, getAgentRunForViewer, resetAgentRunAttributionAvailabilityCache, resetAgentRunCredentialSourceAvailabilityCache } from "@/lib/agent-runs"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const NOW = new Date("2026-10-05T12:00:00.000Z")
const RUN_ID = "11111111-1111-4111-8111-111111111111"
const cleanup = { stopSandbox: vi.fn(), revokeKey: vi.fn(), finishClaim: vi.fn() }

/** `access` is what the conversation lookup returns: the owner id, or null for no access. */
function fakePrisma(access: { userId: string } | null, run: Record<string, unknown> = {}) {
  const prisma: Any = {
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: RUN_ID, userId: "starter", conversationId: "c-1", workspaceId: "ws-1", ...run }),
      findMany: vi.fn().mockResolvedValue([]), // the migration-100 availability probe
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    agentConversation: { findFirst: vi.fn().mockResolvedValue(access), update: vi.fn().mockResolvedValue({}) },
    agentConversationParticipant: { findFirst: vi.fn().mockResolvedValue(null) },
    agentMessage: { create: vi.fn().mockResolvedValue({ id: "m" }) },
    agentAuditLog: { createMany: vi.fn().mockResolvedValue({}) },
  }
  prisma.$transaction = (fn: (tx: Any) => Promise<unknown>) => fn(prisma)
  return prisma
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentParticipantsAvailabilityCache()
  resetAgentRunAttributionAvailabilityCache()
  resetAgentRunCredentialSourceAvailabilityCache()
})

describe("getAgentRunForViewer", () => {
  it("shows the run to anyone with access to its conversation, not just who started it", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    const run = await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "someone-invited" })
    expect(run).toMatchObject({ id: RUN_ID, userId: "starter" })
    expect(prisma.agentConversation.findFirst.mock.calls[0][0]).toMatchObject({
      where: { id: "c-1", workspaceId: "ws-1", workspace: { members: { some: { userId: "someone-invited" } } } },
    })
  })

  it("names the cloud agent a run acted as, and reads a legacy run as the built-in agent", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findFirst
      .mockResolvedValueOnce({ id: RUN_ID, userId: "starter", conversationId: "c-1", workspaceId: "ws-1" })
      .mockResolvedValueOnce({ agentId: "agent-1" })
    prisma.agent = { findFirst: vi.fn().mockResolvedValue({ id: "agent-1", name: "Triage", status: "ACTIVE" }) }
    expect(await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "owner" })).toMatchObject({ agentId: "agent-1", agentName: "Triage" })
    prisma.agentRun.findFirst
      .mockResolvedValueOnce({ id: RUN_ID, userId: "starter", conversationId: "c-1", workspaceId: "ws-1" })
      .mockResolvedValueOnce({ agentId: null })
    expect(await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "owner" })).toMatchObject({ agentId: null, agentName: null })
  })

  it("still shows the run (as the built-in agent) while migration 100 is unapplied", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findMany.mockRejectedValue(Object.assign(new Error("column agent_id does not exist"), { code: "P2022" }))
    const run = await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "owner" })
    expect(run).toMatchObject({ id: RUN_ID, agentId: null, agentName: null })
    expect(prisma.agentRun.findFirst).toHaveBeenCalledTimes(1)
  })

  it("returns the credential source label for the viewer, and null (unknown) for a run that has none or while migration 111 is unapplied", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findFirst
      .mockResolvedValueOnce({ id: RUN_ID, userId: "starter", conversationId: "c-1", workspaceId: "ws-1" })
      .mockResolvedValueOnce({ agentId: null })
      .mockResolvedValueOnce({ credentialSource: "workspace-api-key" })
    expect(await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "owner" })).toMatchObject({ credentialSource: "workspace-api-key" })

    resetAgentRunCredentialSourceAvailabilityCache()
    prisma.agentRun.findMany.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      select.credentialSource ? Promise.reject(Object.assign(new Error("column credential_source does not exist"), { code: "P2022" })) : Promise.resolve([]))
    prisma.agentRun.findFirst.mockReset()
    prisma.agentRun.findFirst
      .mockResolvedValueOnce({ id: RUN_ID, userId: "starter", conversationId: "c-1", workspaceId: "ws-1" })
      .mockResolvedValueOnce({ agentId: null })
    expect(await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "owner" })).toMatchObject({ credentialSource: null })
  })

  it("returns null (a 404 upstream) when the viewer has no access, even to their own old run", async () => {
    const prisma = fakePrisma(null)
    expect(await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "starter" })).toBeNull()
  })

  it("returns null for an unknown run without consulting the conversation", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findFirst.mockResolvedValue(null)
    expect(await getAgentRunForViewer({ prisma, runId: RUN_ID, userId: "owner" })).toBeNull()
    expect(prisma.agentConversation.findFirst).not.toHaveBeenCalled()
  })
})

describe("cancelAgentRun", () => {
  const cancel = (prisma: Any, userId: string) => cancelAgentRun({ prisma, runId: RUN_ID, userId, now: NOW, cleanup })

  it("lets the person who started the run stop it", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findUnique.mockResolvedValue({ id: RUN_ID, status: "RUNNING", conversationId: "c-1", workspaceId: "ws-1", userId: "starter" })
    await expect(cancel(prisma, "starter")).resolves.toMatchObject({ finalized: true, status: "CANCELED" })
  })

  it("lets the conversation owner stop a run a participant started", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findUnique.mockResolvedValue({ id: RUN_ID, status: "RUNNING", conversationId: "c-1", workspaceId: "ws-1", userId: "starter" })
    await expect(cancel(prisma, "owner")).resolves.toMatchObject({ finalized: true, status: "CANCELED" })
  })

  it("refuses a third participant with 403, and stops nothing", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    const error = await cancel(prisma, "bystander").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentRunError)
    expect(error).toMatchObject({ status: 403, code: "RUN_CANCEL_FORBIDDEN" })
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled()
    expect(cleanup.stopSandbox).not.toHaveBeenCalled()
  })

  it("404s once the starter has lost access (left, removed, or no longer in the workspace)", async () => {
    const prisma = fakePrisma(null)
    await expect(cancel(prisma, "starter")).rejects.toMatchObject({ status: 404, code: "RUN_NOT_FOUND" })
    expect(prisma.agentRun.updateMany).not.toHaveBeenCalled()
  })

  it("404s for a run that does not exist", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findFirst.mockResolvedValue(null)
    await expect(cancel(prisma, "owner")).rejects.toMatchObject({ status: 404 })
  })
})

describe("finalizeAgentRun attribution", () => {
  it("records the person who asked as the author of the assistant message, so usage is charged to them", async () => {
    const prisma = fakePrisma({ userId: "owner" })
    prisma.agentRun.findUnique.mockResolvedValue({
      id: RUN_ID, status: "RUNNING", conversationId: "c-1", workspaceId: "ws-1", userId: "starter", kind: "CHAT", apiKeyId: null, sandboxName: "s",
    })
    await finalizeAgentRun({ prisma, runId: RUN_ID, status: "SUCCEEDED", text: "done", now: NOW, cleanup })
    expect(prisma.agentMessage.create.mock.calls[0][0]).toMatchObject({
      data: { role: "assistant", authorUserId: "starter" },
      select: { id: true },
    })
  })
})
