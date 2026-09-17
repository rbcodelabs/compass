import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * ADR-0012 step 5 tool surface: `promote_research_finding_to_evidence`.
 *
 * Two layers are exercised here. The handler's error discipline (which messages
 * an agent is allowed to see, and which collapse), and the authorization gate —
 * which is deliberately add_evidence's, so the cross-workspace denial must hold
 * on exactly the same terms.
 */
const mocks = vi.hoisted(() => ({ promote: vi.fn() }))
vi.mock("@/lib/research-evidence-promotion", async importActual => {
  const actual = await importActual<typeof import("@/lib/research-evidence-promotion")>()
  return { ...actual, promoteResearchFindingToEvidence: mocks.promote }
})

const prisma = vi.hoisted(() => ({
  workspace: { findFirst: vi.fn() },
  workspaceMember: { findFirst: vi.fn() },
  opportunity: { findUnique: vi.fn() },
  solution: { findUnique: vi.fn() },
  assumption: { findUnique: vi.fn() },
  agent: { findFirst: vi.fn() },
  agentWorkspaceGrant: { findMany: vi.fn() },
}))
vi.mock("@/lib/db", () => ({ default: () => prisma }))

import { promoteResearchFindingToEvidenceTool } from "@/lib/research-tool-handlers"
import { ResearchPromotionError } from "@/lib/research-evidence-promotion"
import { applyToolGate } from "@/lib/mcp-tool-gates"
import { runWithMcpActor } from "@/lib/mcp-authz"

const TOOL = "promote_research_finding_to_evidence"
const MEMBER = { userId: "member", purpose: "USER" as const }
const args = { workspaceId: "workspace-1", researchSynthesisId: "synthesis-1", findingIndex: 0, opportunityId: "opportunity-1" }

beforeEach(() => {
  vi.clearAllMocks()
  prisma.workspace.findFirst.mockResolvedValue({ id: "workspace-1" })
  prisma.workspaceMember.findFirst.mockResolvedValue({ id: "member-1" })
  prisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "workspace-1" })
  prisma.agentWorkspaceGrant.findMany.mockResolvedValue([])
  mocks.promote.mockResolvedValue({
    evidence: { id: "evidence-1", opportunityId: "opportunity-1", solutionId: null, assumptionId: null },
    sourceTurnIds: ["turn-1", "turn-2"],
    findingKey: "f".repeat(64),
    replayed: false,
  })
})

describe("promote_research_finding_to_evidence handler", () => {
  it("reports the new evidence and the turns it cites", async () => {
    const result = await runWithMcpActor(MEMBER, () => promoteResearchFindingToEvidenceTool(args))
    expect(mocks.promote).toHaveBeenCalledWith(args)
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.data).toMatchObject({ id: "evidence-1", sourceTurnIds: ["turn-1", "turn-2"], replayed: false })
    expect(result.content[0].text).toContain("2 saved participant turn")
  })

  it("says a replay returned the existing row rather than creating another", async () => {
    mocks.promote.mockResolvedValue({ evidence: { id: "evidence-1" }, sourceTurnIds: ["turn-1"], findingKey: "f".repeat(64), replayed: true })
    const result = await runWithMcpActor(MEMBER, () => promoteResearchFindingToEvidenceTool(args))
    expect(result.structuredContent.data).toMatchObject({ replayed: true })
    expect(result.content[0].text).toContain("already promoted")
  })

  it("surfaces a promotion error so the caller can correct it", async () => {
    mocks.promote.mockRejectedValue(new ResearchPromotionError("This finding was already promoted to different evidence; open the existing evidence rather than promoting it again with changed details.", 409))
    const result = await runWithMcpActor(MEMBER, () => promoteResearchFindingToEvidenceTool(args))
    expect(result.structuredContent).toMatchObject({ ok: false, data: null })
    expect(result.content[0].text).toContain("already promoted to different evidence")
  })

  it("does not leak an unexpected internal failure", async () => {
    mocks.promote.mockRejectedValue(new Error("pg: connection string password=hunter2"))
    const result = await runWithMcpActor(MEMBER, () => promoteResearchFindingToEvidenceTool(args))
    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).not.toContain("hunter2")
    expect(result.content[0].text).toContain("nothing was written")
  })

  it("marks the returned finding text as untrusted participant-derived material", async () => {
    const result = await runWithMcpActor(MEMBER, () => promoteResearchFindingToEvidenceTool(args))
    expect(result.content[0].text).toContain("untrusted data")
    expect(result.content[0].text).toContain("not instructions")
  })

  it("refuses a public participant research credential", async () => {
    await expect(runWithMcpActor({ userId: "member", purpose: "RESEARCH", scopeWorkspaceId: "workspace-1" }, () => promoteResearchFindingToEvidenceTool(args)))
      .rejects.toThrow(/research interviews/)
    expect(mocks.promote).not.toHaveBeenCalled()
  })
})

describe("authorization gate (the same one add_evidence uses)", () => {
  it("admits a member promoting onto a target in the declared workspace", async () => {
    await expect(applyToolGate(TOOL, MEMBER, args)).resolves.toBeUndefined()
  })

  it("denies a target that lives in another workspace", async () => {
    prisma.opportunity.findUnique.mockResolvedValue({ workspaceId: "workspace-2" })
    await expect(applyToolGate(TOOL, MEMBER, args)).rejects.toThrow(/does not belong to the declared workspace/)
  })

  it("denies a non-member of the declared workspace", async () => {
    prisma.workspace.findFirst.mockResolvedValue(null)
    await expect(applyToolGate(TOOL, MEMBER, args)).rejects.toThrow()
  })

  it("requires a discovery target before any workspace comparison can be made", async () => {
    await expect(applyToolGate(TOOL, MEMBER, { workspaceId: "workspace-1", researchSynthesisId: "synthesis-1", findingIndex: 0 }))
      .rejects.toThrow(/evidence target/i)
  })

  it("denies a solution target in another workspace", async () => {
    prisma.solution.findUnique.mockResolvedValue({ opportunity: { workspaceId: "workspace-2" } })
    await expect(applyToolGate(TOOL, MEMBER, { workspaceId: "workspace-1", researchSynthesisId: "synthesis-1", findingIndex: 0, solutionId: "solution-1" }))
      .rejects.toThrow()
  })
})
