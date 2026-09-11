/**
 * Unit tests for lib/agent-context.ts — the "Send to agent" hand-off resolver.
 *
 * Resolves an approved Solution Plan or approved tracked Decision Record into
 * a small context bundle for the agent chat: a chip label/summary, a suggested
 * (editable) composer instruction, a prompt-fold block for /api/agent/turn,
 * and a link back to the source. Every failure mode (wrong state, wrong
 * workspace, not found) degrades to `null` rather than throwing — the caller
 * is expected to silently proceed without a chip/context per spec.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPrisma = {
  solutionComment: { findFirst: vi.fn() },
  reviewRequest: { findFirst: vi.fn() },
}
vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { resolveAgentHandoffContext } from "@/lib/agent-context"

const WORKSPACE_ID = "ws-1"
const USER_ID = "user-1"

function workspaceSelection() {
  return { slug: "acme-workspace", organization: { slug: "acme-org" } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("resolveAgentHandoffContext — solutionPlan", () => {
  it("returns null for an unknown entityType", async () => {
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "roadmapItem",
      entityId: "plan-1",
    })
    expect(result).toBeNull()
    expect(mockPrisma.solutionComment.findFirst).not.toHaveBeenCalled()
    expect(mockPrisma.reviewRequest.findFirst).not.toHaveBeenCalled()
  })

  it("happy path: resolves an approved plan into a chip + prompt block + source link", async () => {
    mockPrisma.solutionComment.findFirst.mockResolvedValue({
      id: "plan-1",
      body: "Ship a redesigned onboarding flow in two phases.",
      planStatus: "APPROVED",
      solution: {
        id: "sol-1",
        title: "Redesigned onboarding",
        opportunity: { id: "opp-1", workspace: workspaceSelection() },
      },
    })

    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "solutionPlan",
      entityId: "plan-1",
    })

    expect(result).not.toBeNull()
    expect(result!.label).toContain("Redesigned onboarding")
    expect(result!.summary).toContain("onboarding flow")
    expect(result!.suggestedInstruction).toContain("Redesigned onboarding")
    expect(result!.promptBlock).toContain("Ship a redesigned onboarding flow in two phases.")
    expect(result!.sourceUrl).toBe("/acme-org/acme-workspace/discovery/opp-1?detail=solution:sol-1")

    // Membership + workspace scoping must be enforced in the query itself.
    const arg = mockPrisma.solutionComment.findFirst.mock.calls[0][0]
    expect(arg.where.id).toBe("plan-1")
    expect(arg.where.commentType).toBe("PLAN")
    expect(arg.where.solution.opportunity.workspaceId).toBe(WORKSPACE_ID)
    expect(arg.where.solution.opportunity.workspace.members.some.userId).toBe(USER_ID)
  })

  it("returns null when the plan is not APPROVED (e.g. still PENDING)", async () => {
    mockPrisma.solutionComment.findFirst.mockResolvedValue({
      id: "plan-1",
      body: "Draft plan.",
      planStatus: "PENDING",
      solution: { id: "sol-1", title: "Redesigned onboarding", opportunity: { id: "opp-1", workspace: workspaceSelection() } },
    })
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "solutionPlan",
      entityId: "plan-1",
    })
    expect(result).toBeNull()
  })

  it("returns null when the plan belongs to a different workspace (query excludes it)", async () => {
    // The where-clause scopes by workspaceId + membership, so a cross-workspace
    // id simply never matches — Prisma returns null, same as not-found.
    mockPrisma.solutionComment.findFirst.mockResolvedValue(null)
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "solutionPlan",
      entityId: "plan-in-other-workspace",
    })
    expect(result).toBeNull()
    const arg = mockPrisma.solutionComment.findFirst.mock.calls[0][0]
    expect(arg.where.solution.opportunity.workspaceId).toBe(WORKSPACE_ID)
  })

  it("returns null when the plan id does not exist", async () => {
    mockPrisma.solutionComment.findFirst.mockResolvedValue(null)
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "solutionPlan",
      entityId: "does-not-exist",
    })
    expect(result).toBeNull()
  })
})

describe("resolveAgentHandoffContext — decision", () => {
  function decisionRow(overrides: Partial<{ decisions: unknown[]; packetJson: string; summary: string | null }> = {}) {
    return {
      id: "req-1",
      workspace: workspaceSelection(),
      currentRevision: {
        id: "rev-1",
        title: "Adopt the new pricing tier",
        summary: overrides.summary ?? "Short summary of the decision.",
        packetJson: overrides.packetJson ?? JSON.stringify({
          schemaVersion: "tracked-decision/v2",
          question: "Should we adopt the new pricing tier?",
          context: "Full context text about the pricing change.",
          entity: { type: "OPPORTUNITY", id: "opp-1", title: "Pricing", updatedAt: new Date().toISOString() },
          sources: [],
        }),
        decisions: overrides.decisions ?? [{ option: { outcomeClass: "APPROVE" } }],
      },
    }
  }

  it("happy path: resolves an approved tracked decision into a chip + prompt block + source link", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(decisionRow())
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-1",
    })
    expect(result).not.toBeNull()
    expect(result!.label).toContain("Adopt the new pricing tier")
    expect(result!.promptBlock).toContain("Full context text about the pricing change.")
    expect(result!.sourceUrl).toBe("/acme-org/acme-workspace/reviews/req-1")

    const arg = mockPrisma.reviewRequest.findFirst.mock.calls[0][0]
    expect(arg.where.id).toBe("req-1")
    expect(arg.where.workspaceId).toBe(WORKSPACE_ID)
    expect(arg.where.gateType).toBe("TRACKED_DECISION")
    expect(arg.where.workspace.members.some.userId).toBe(USER_ID)
  })

  it("truncates a long context field and points back to the source", async () => {
    const longContext = "x".repeat(5000)
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(decisionRow({
      packetJson: JSON.stringify({
        schemaVersion: "tracked-decision/v2",
        question: "q",
        context: longContext,
        entity: { type: "OPPORTUNITY", id: "opp-1", title: "Pricing", updatedAt: new Date().toISOString() },
        sources: [],
      }),
    }))
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-1",
    })
    expect(result).not.toBeNull()
    expect(result!.promptBlock.length).toBeLessThan(longContext.length)
    expect(result!.promptBlock).toContain("/acme-org/acme-workspace/reviews/req-1")
  })

  it("returns null when there is no decision yet on the current revision", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(decisionRow({ decisions: [] }))
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-1",
    })
    expect(result).toBeNull()
  })

  it("returns null when the decided outcome is REJECT, not APPROVE", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(decisionRow({ decisions: [{ option: { outcomeClass: "REJECT" } }] }))
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-1",
    })
    expect(result).toBeNull()
  })

  it("returns null when the decided outcome is REQUEST_CHANGES", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(decisionRow({ decisions: [{ option: { outcomeClass: "REQUEST_CHANGES" } }] }))
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-1",
    })
    expect(result).toBeNull()
  })

  it("returns null when the request belongs to a different workspace or user lacks membership (query excludes it)", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(null)
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-in-other-workspace",
    })
    expect(result).toBeNull()
  })

  it("returns null when the request id does not exist", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(null)
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "does-not-exist",
    })
    expect(result).toBeNull()
  })

  it("falls back to the revision summary when the packet fails to parse", async () => {
    mockPrisma.reviewRequest.findFirst.mockResolvedValue(decisionRow({ packetJson: "not json", summary: "Fallback summary text." }))
    const result = await resolveAgentHandoffContext({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      entityType: "decision",
      entityId: "req-1",
    })
    expect(result).not.toBeNull()
    expect(result!.promptBlock).toContain("Fallback summary text.")
  })
})
