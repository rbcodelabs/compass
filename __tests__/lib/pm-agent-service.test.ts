import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
const db = vi.hoisted(() => ({ workspaceMember: { findFirst: vi.fn() }, agentConversation: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }, pMInterview: { findFirst: vi.fn() }, opportunity: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, $transaction: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => db }))
import { withInterviewMutation, claimInterviewProcessing, finishInterviewProcessing, gateInterviewTool, reportPmAgentFailure, failPendingInterviewProcessing } from "@/lib/pm-agent-service"
import { runWithMcpActor } from "@/lib/mcp-authz"
import { updateOpportunity } from "@/lib/opportunity-tool-handlers"

const id = "00000000-0000-4000-8000-000000000001"
const actor = { userId: "owner", purpose: "AGENT_TURN" as const, scopeWorkspaceId: "ws", scopeConversationId: "conversation", scopeClaimId: "claim" }
let target: { id: string; title: string; description: string; customerSegment: null; status: string; updatedAt: Date }
let conversation: { id: string; interviewProcessingJson: string }
const hash = () => createHash("sha256").update(JSON.stringify([["title", target.title], ["description", target.description], ["customerSegment", null], ["status", target.status]])).digest("hex")
const args = () => ({ opportunityId: id, title: "New title", expectedUpdatedAt: target.updatedAt.toISOString(), expectedFieldsFingerprint: hash() })

beforeEach(() => {
  vi.resetAllMocks()
  db.workspaceMember.findFirst.mockResolvedValue({ id: "member" })
  target = { id, title: "Old", description: "Retain", customerSegment: null, status: "EXPLORING", updatedAt: new Date("2026-09-12T00:00:00Z") }
  conversation = { id: "conversation", interviewProcessingJson: JSON.stringify({ status: "RUNNING", interviewId: "interview", claimId: "claim", deadline: Date.now() + 60_000, targetUrl: "/item" }) }
  db.agentConversation.findFirst.mockImplementation(async () => ({ ...conversation }))
  db.agentConversation.findUnique.mockImplementation(async () => ({ ...conversation }))
  db.agentConversation.updateMany.mockImplementation(async ({ data }) => { conversation.interviewProcessingJson = data.interviewProcessingJson; return { count: 1 } })
  db.pMInterview.findFirst.mockResolvedValue({ id: "interview", targetId: id, targetType: "OPPORTUNITY", workspaceId: "ws" })
  db.opportunity.findFirst.mockImplementation(async () => ({ ...target }))
  db.opportunity.findUnique.mockImplementation(async () => ({ ...target }))
  db.opportunity.update.mockImplementation(async ({ data }) => { target = { ...target, ...data }; return { ...target } })
  db.$transaction.mockImplementation(async fn => {
    const before = { ...target }, old = { ...conversation }
    try { return await fn(db) } catch (error) { target = before; conversation = old; throw error }
  })
})

describe("core interview mutation boundary", () => {
  it("turns pending preflight failure into explicit retry without clearing an active worker", async () => {
    await failPendingInterviewProcessing("conversation", "owner", "ws")
    expect(db.agentConversation.updateMany).not.toHaveBeenCalled()
    conversation.interviewProcessingJson = JSON.stringify({ status: "PENDING", interviewId: "interview" })
    await failPendingInterviewProcessing("conversation", "owner", "ws")
    expect(JSON.parse(conversation.interviewProcessingJson).status).toBe("FAILED")
    expect(db.agentConversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "owner", workspaceId: "ws" }) }))
  })
  it("logs only fixed diagnostic categories, not provider text or transcripts", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      reportPmAgentFailure("conversation", "claim", "execute", new Error("timeout private transcript and provider secret"))
      expect(log).toHaveBeenCalledWith("PM interview core agent failed", { conversationId: "conversation", claimId: "claim", stage: "execute", category: "deadline_exceeded" })
      expect(JSON.stringify(log.mock.calls)).not.toContain("private")
    } finally { log.mockRestore() }
  })
  it("uses the normal handler and saves before/after receipt atomically", async () => {
    const input = args()
    await runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, () => updateOpportunity(input)))
    expect(target.title).toBe("New title")
    expect(JSON.parse(conversation.interviewProcessingJson).receipt).toMatchObject({ changedFields: ["title"], before: { title: "Old" }, after: { title: "New title" }, targetUrl: "/item" })
  })
  it("rolls back the normal edit if receipt commit fails", async () => {
    db.agentConversation.updateMany.mockRejectedValue(new Error("injected commit failure"))
    const input = args()
    await expect(runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, () => updateOpportunity(input)))).rejects.toThrow("injected")
    expect(target.title).toBe("Old")
  })
  it("does not run a changed second mutation after success", async () => {
    const input = args(), handler = vi.fn(() => updateOpportunity(input))
    await runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, handler))
    await runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, handler))
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", { ...input, title: "Again" }, handler))).rejects.toThrow(/already/)
  })
  it("keeps the committed receipt after failed stream completion", async () => {
    const input = args()
    await runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, () => updateOpportunity(input)))
    await finishInterviewProcessing("conversation", "claim", false)
    expect(JSON.parse(conversation.interviewProcessingJson).status).toBe("SUCCEEDED")
  })
  it("rejects superseded credentials before calling a handler", async () => {
    const handler = vi.fn()
    await expect(runWithMcpActor({ ...actor, scopeClaimId: "old" }, () => withInterviewMutation("update_opportunity", args(), handler))).rejects.toThrow(/expired/)
    expect(handler).not.toHaveBeenCalled()
  })
  it("rejects a same-timestamp field change", async () => {
    const input = args(); target.description = "Concurrent human edit"
    await expect(runWithMcpActor(actor, () => withInterviewMutation("update_opportunity", input, vi.fn()))).rejects.toThrow(/fields changed/)
  })
  it("requires exact owner/workspace and rejects lifecycle mutation", async () => {
    await expect(gateInterviewTool(actor, "update_opportunity_status", { opportunityId: id, status: "ACTIVE" })).rejects.toThrow()
    db.agentConversation.findFirst.mockResolvedValue(null)
    await expect(gateInterviewTool(actor, "get_pm_interview", { interviewId: "interview" })).rejects.toThrow()
  })
  it("rejects a revoked membership even with an unexpired credential", async () => {
    db.workspaceMember.findFirst.mockResolvedValue(null)
    await expect(gateInterviewTool(actor, "get_pm_interview", { interviewId: "interview" })).rejects.toThrow(/access denied/)
  })
  it("deduplicates running dispatch and requires explicit failed retry", async () => {
    expect(await claimInterviewProcessing("conversation", "owner", "ws", false)).toMatchObject({ claimed: false })
    conversation.interviewProcessingJson = JSON.stringify({ status: "FAILED", interviewId: "interview" })
    expect(await claimInterviewProcessing("conversation", "owner", "ws", false)).toMatchObject({ claimed: false })
    expect(await claimInterviewProcessing("conversation", "owner", "ws", true)).toMatchObject({ claimed: true, state: { status: "RUNNING" } })
  })
})
