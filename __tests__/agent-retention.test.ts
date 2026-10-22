import { beforeEach, describe, expect, it, vi } from "vitest"
import { createFakePrisma, type Row } from "./helpers/fake-prisma"
import { pruneAgentData, retentionCutoff } from "@/lib/agent-retention"
import { AGENT_DATA_RETENTION_DAYS } from "@/lib/legal-config"

const NOW = new Date("2026-10-21T12:00:00.000Z")
const day = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(NOW.getTime() - days * day)
const del = vi.fn(async (key: string) => void key)
const storage = () => ({ del, put: vi.fn(), get: vi.fn() })

function seed(extra: Record<string, Row[]> = {}) {
  return {
    agentConversation: [
      { id: "conv-old-empty", updatedAt: ago(400) },
      { id: "conv-old-with-new-message", updatedAt: ago(400) },
      { id: "conv-old-with-recent-run", updatedAt: ago(400) },
      { id: "conv-active", updatedAt: ago(2) },
    ],
    agentMessage: [
      { id: "m-old-1", conversationId: "conv-old-empty", createdAt: ago(500) },
      { id: "m-old-2", conversationId: "conv-active", createdAt: ago(366) },
      { id: "m-edge", conversationId: "conv-active", createdAt: ago(364) },
      { id: "m-new", conversationId: "conv-active", createdAt: ago(1) },
      { id: "m-new-in-old-conv", conversationId: "conv-old-with-new-message", createdAt: ago(10) },
    ],
    agentRun: [
      { id: "run-old", conversationId: "conv-old-empty", createdAt: ago(500) },
      { id: "run-recent", conversationId: "conv-old-with-recent-run", createdAt: ago(5) },
      { id: "run-active", conversationId: "conv-active", createdAt: ago(1) },
    ],
    agentRunEvent: [
      { id: "ev-old-1", runId: "run-old", createdAt: ago(500) },
      { id: "ev-old-2", runId: "run-active", createdAt: ago(400) },
      { id: "ev-new", runId: "run-active", createdAt: ago(1) },
    ],
    agentSession: [
      { conversationId: "conv-old-empty", blobKey: "blob/old-empty", updatedAt: ago(450) },
      { conversationId: "conv-active", blobKey: "blob/active", updatedAt: ago(1) },
    ],
    agentConversationParticipant: [{ id: "p1", conversationId: "conv-old-empty" }],
    ...extra,
  } as Record<string, Row[]>
}

beforeEach(() => {
  del.mockReset()
  del.mockResolvedValue(undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

describe("retentionCutoff", () => {
  it("is exactly the published number of days before now", () => {
    expect(AGENT_DATA_RETENTION_DAYS).toBe(365)
    expect(retentionCutoff(NOW).toISOString()).toBe("2025-10-21T12:00:00.000Z")
  })
})

describe("pruneAgentData", () => {
  it("deletes run events and messages older than a year and keeps everything newer", async () => {
    const { prisma, rows } = createFakePrisma(seed())
    const result = await pruneAgentData({ prisma, now: NOW, storage })
    expect(result).toMatchObject({ runEventsDeleted: 2, messagesDeleted: 2, truncated: false })
    expect(rows("agentRunEvent").map((e) => e.id)).toEqual(["ev-new"])
    expect(rows("agentMessage").map((m) => m.id).sort()).toEqual(["m-edge", "m-new", "m-new-in-old-conv"])
  })

  it("deletes the session transcript of any conversation it prunes messages from, before the messages go", async () => {
    const { prisma, rows, calls } = createFakePrisma(seed())
    await pruneAgentData({ prisma, now: NOW, storage })
    // conv-active had a message pruned, so its transcript (which embeds that message) goes even though the conversation is live.
    expect(del).toHaveBeenCalledWith("blob/active")
    expect(rows("agentSession")).toEqual([])
    const sessionDelete = calls.findIndex((c) => c.model === "agentSession" && c.op === "deleteMany")
    const messageDelete = calls.findIndex((c) => c.model === "agentMessage" && c.op === "deleteMany")
    expect(sessionDelete).toBeLessThan(messageDelete)
  })

  it("deletes the transcript of a conversation idle for the whole period", async () => {
    const { prisma, rows } = createFakePrisma(seed({
      agentMessage: [],
      agentSession: [{ conversationId: "conv-idle", blobKey: "blob/idle", updatedAt: ago(380) }, { conversationId: "conv-fresh", blobKey: "blob/fresh", updatedAt: ago(30) }],
    }))
    const result = await pruneAgentData({ prisma, now: NOW, storage })
    expect(result.transcriptsDeleted).toBe(1)
    expect(del).toHaveBeenCalledWith("blob/idle")
    expect(rows("agentSession").map((s) => s.conversationId)).toEqual(["conv-fresh"])
  })

  it("removes only empty stale conversation shells, with their runs and participants", async () => {
    const { prisma, rows } = createFakePrisma(seed())
    const result = await pruneAgentData({ prisma, now: NOW, storage })
    expect(result.conversationsDeleted).toBe(1)
    expect(rows("agentConversation").map((c) => c.id).sort()).toEqual(["conv-active", "conv-old-with-new-message", "conv-old-with-recent-run"])
    expect(rows("agentRun").map((r) => r.id).sort()).toEqual(["run-active", "run-recent"])
    expect(rows("agentConversationParticipant")).toEqual([])
  })

  it("never deletes a stale-looking conversation that still has a message or a recent run", async () => {
    const { prisma, rows } = createFakePrisma(seed())
    await pruneAgentData({ prisma, now: NOW, storage })
    const ids = rows("agentConversation").map((c) => c.id)
    expect(ids).toContain("conv-old-with-new-message")
    expect(ids).toContain("conv-old-with-recent-run")
  })

  it("is idempotent: a second run deletes nothing", async () => {
    const { prisma } = createFakePrisma(seed())
    await pruneAgentData({ prisma, now: NOW, storage })
    const second = await pruneAgentData({ prisma, now: NOW, storage })
    expect(second).toMatchObject({ runEventsDeleted: 0, messagesDeleted: 0, transcriptsDeleted: 0, conversationsDeleted: 0, truncated: false })
  })

  it("works through a large backlog in bounded pages", async () => {
    const events = Array.from({ length: 1_250 }, (_, i) => ({ id: `ev-${i}`, runId: "run-x", createdAt: ago(600) }))
    const messages = Array.from({ length: 1_250 }, (_, i) => ({ id: `msg-${i}`, conversationId: "conv-x", createdAt: ago(600) }))
    const { prisma, calls, rows } = createFakePrisma({ agentRunEvent: events, agentMessage: messages })
    const result = await pruneAgentData({ prisma, now: NOW, storage })
    expect(result).toMatchObject({ runEventsDeleted: 1_250, messagesDeleted: 1_250 })
    const deletes = calls.filter((c) => c.op === "deleteMany" && (c.where as { id?: unknown })?.id)
    expect(deletes.length).toBeGreaterThanOrEqual(6)
    for (const call of deletes) expect((call.where as { id: { in: string[] } }).id.in.length).toBeLessThanOrEqual(500)
    expect(rows("agentRunEvent")).toEqual([])
  })

  it("stops at its time budget and leaves the rest for the next run, which resumes", async () => {
    const events = Array.from({ length: 1_250 }, (_, i) => ({ id: `ev-${i}`, runId: "run-x", createdAt: ago(600) }))
    const { prisma, rows } = createFakePrisma({ agentRunEvent: events })
    const first = await pruneAgentData({ prisma, now: NOW, storage, budgetMs: 0 })
    expect(first.truncated).toBe(true)
    expect(rows("agentRunEvent").length).toBeGreaterThan(0)
    const next = await pruneAgentData({ prisma, now: NOW, storage })
    expect(next.truncated).toBe(false)
    expect(rows("agentRunEvent")).toEqual([])
  })

  it("keeps a conversation's messages while its transcript object cannot be deleted, and retries next run", async () => {
    let outage = true
    del.mockImplementation(async (key: string) => {
      if (outage && key === "blob/active") throw new Error("blob outage")
    })
    const { prisma, rows } = createFakePrisma(seed())
    const first = await pruneAgentData({ prisma, now: NOW, storage })
    expect(first.transcriptsFailed).toBeGreaterThanOrEqual(1)
    // The failing conversation keeps the old message that its surviving transcript still embeds.
    expect(rows("agentMessage").some((m) => m.id === "m-old-2")).toBe(true)
    expect(rows("agentSession").some((s) => s.blobKey === "blob/active")).toBe(true)

    outage = false
    const second = await pruneAgentData({ prisma, now: NOW, storage })
    expect(second.transcriptsFailed).toBe(0)
    expect(rows("agentMessage").some((m) => m.id === "m-old-2")).toBe(false)
    expect(rows("agentSession").some((s) => s.blobKey === "blob/active")).toBe(false)
  })

  it("tolerates deployments where the run or session tables are not migrated", async () => {
    const { prisma, rows } = createFakePrisma(seed(), { missingTables: ["agentRun", "agentRunEvent", "agentSession", "agentConversationParticipant"] })
    const result = await pruneAgentData({ prisma, now: NOW, storage })
    expect(result.messagesDeleted).toBe(2)
    expect(rows("agentMessage").some((m) => m.id === "m-old-1")).toBe(false)
  })

  it("honors a configured retention period", async () => {
    const { prisma, rows } = createFakePrisma(seed())
    await pruneAgentData({ prisma, now: NOW, storage, retentionDays: 30 })
    expect(rows("agentMessage").map((m) => m.id)).toEqual(["m-new", "m-new-in-old-conv"])
  })
})
