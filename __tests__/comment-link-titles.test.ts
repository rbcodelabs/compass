import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPrisma = vi.hoisted(() => ({
  comment: { findMany: vi.fn() },
  opportunity: { findMany: vi.fn() },
  solution: { findMany: vi.fn() },
  assumption: { findMany: vi.fn() },
  experiment: { findMany: vi.fn() },
  roadmapItem: { findMany: vi.fn() },
  objective: { findMany: vi.fn() },
  keyResult: { findMany: vi.fn() },
  feedbackItem: { findMany: vi.fn() },
  task: { findMany: vi.fn() },
  doc: { findMany: vi.fn() },
  artifact: { findMany: vi.fn() },
  researchStudy: { findMany: vi.fn() },
  reviewRequest: { findMany: vi.fn() },
}))

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { commentLinkTitles, resolveCommentLinks } from "@/lib/comment-link-titles"

const WS = "a039b32f-47a1-4c57-9e21-c2e7dde7af33"
const AGENT_ID = "8a959af2-7387-4c89-8734-9728eb928953"

describe("resolveCommentLinks and commentLinkTitles", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const delegate of Object.values(mockPrisma)) {
      delegate.findMany.mockResolvedValue([])
    }
  })

  it("short-circuits without querying Prisma when commentIds is empty", async () => {
    const resolved = await resolveCommentLinks(WS, [])
    expect(resolved.size).toBe(0)
    expect(mockPrisma.comment.findMany).not.toHaveBeenCalled()
  })

  it("formats non-Doc Discussion comments with parent display ID + cleaned excerpt and builds a deep-link path", async () => {
    mockPrisma.comment.findMany.mockResolvedValue([
      {
        id: "cmt-opp",
        parentId: null,
        targetType: "OPPORTUNITY",
        targetId: "opp-7",
        body: `there is still a solution space to keep expanding - it has to do with integrating discussion with the ai chat @[Geode MacBook Air](mention:agent:${AGENT_ID})`,
        docAnchor: null,
      },
      {
        id: "cmt-rm",
        parentId: "cmt-rm-root",
        targetType: "ROADMAP_ITEM",
        targetId: "rm-50",
        body: `@[Geode MacBook Air](mention:agent:${AGENT_ID}) please check the timeline`,
        docAnchor: null,
      },
      {
        id: "cmt-sol",
        parentId: null,
        targetType: "SOLUTION",
        targetId: "sol-123",
        body: "Verify edge cases on mobile",
        docAnchor: null,
      },
    ])
    mockPrisma.opportunity.findMany.mockResolvedValue([
      { id: "opp-7", title: "Doc comments can't turn feedback into assigned work", seqPrefix: "OPP", seqNumber: 7 },
    ])
    mockPrisma.roadmapItem.findMany.mockResolvedValue([
      { id: "rm-50", title: "Clickable comment links", seqPrefix: "RM", seqNumber: 50 },
    ])
    mockPrisma.solution.findMany.mockResolvedValue([
      {
        id: "sol-123",
        title: "Comment provenance",
        opportunityId: "opp-7",
        seqPrefix: "SOL",
        seqNumber: 123,
        opportunity: { seqPrefix: "OPP", seqNumber: 7 },
      },
    ])

    const resolved = await resolveCommentLinks(WS, ["cmt-opp", "cmt-rm", "cmt-sol"])
    expect(resolved.get("COMMENT:cmt-opp")).toEqual({
      commentId: "cmt-opp",
      rootCommentId: "cmt-opp",
      targetType: "OPPORTUNITY",
      targetId: "opp-7",
      title: 'Comment on OPP-7: "there is still a solution space to keep expanding - it has…"',
      workspaceRelativePath: "discovery/OPP-7?comment=cmt-opp",
    })
    expect(resolved.get("COMMENT:cmt-rm")).toEqual({
      commentId: "cmt-rm",
      rootCommentId: "cmt-rm-root",
      targetType: "ROADMAP_ITEM",
      targetId: "rm-50",
      title: 'Comment on RM-50: "@Geode MacBook Air please check the timeline"',
      workspaceRelativePath: "roadmap?detail=roadmapItem%3ARM-50&comment=cmt-rm",
    })
    expect(resolved.get("COMMENT:cmt-sol")).toEqual({
      commentId: "cmt-sol",
      rootCommentId: "cmt-sol",
      targetType: "SOLUTION",
      targetId: "sol-123",
      title: 'Comment on SOL-123: "Verify edge cases on mobile"',
      workspaceRelativePath: "discovery/OPP-7?detail=solution%3ASOL-123&comment=cmt-sol",
    })

    const titles = await commentLinkTitles(WS, ["cmt-opp"])
    expect(titles.get("COMMENT:cmt-opp")).toBe(
      'Comment on OPP-7: "there is still a solution space to keep expanding - it has…"',
    )
  })

  it("preserves anchored Doc comment passage titles while adding deep-link paths to the Doc", async () => {
    mockPrisma.comment.findMany.mockResolvedValue([
      {
        id: "cmt-doc-anchored",
        parentId: null,
        targetType: "DOC",
        targetId: "doc-1",
        body: "Please clarify rollback step",
        docAnchor: { anchorText: "REVIEW the rollout checklist" },
      },
      {
        id: "cmt-doc-plain",
        parentId: null,
        targetType: "DOC",
        targetId: "doc-1",
        body: "General doc feedback here",
        docAnchor: null,
      },
    ])
    mockPrisma.doc.findMany.mockResolvedValue([
      { id: "doc-1", title: "Launch spec", seqPrefix: "DOC", seqNumber: 3 },
    ])

    const resolved = await resolveCommentLinks(WS, ["cmt-doc-anchored", "cmt-doc-plain"])
    expect(resolved.get("COMMENT:cmt-doc-anchored")).toMatchObject({
      title: "Comment on “REVIEW the rollout checklist”",
      workspaceRelativePath: "docs/DOC-3?comment=cmt-doc-anchored",
    })
    expect(resolved.get("COMMENT:cmt-doc-plain")).toMatchObject({
      title: 'Comment on DOC-3: "General doc feedback here"',
      workspaceRelativePath: "docs/DOC-3?comment=cmt-doc-plain",
    })
  })

  it("falls back gracefully when a target row is unnumbered or no longer exists", async () => {
    mockPrisma.comment.findMany.mockResolvedValue([
      {
        id: "cmt-unnumbered",
        parentId: null,
        targetType: "EXPERIMENT",
        targetId: "exp-legacy",
        body: "Check sample size",
        docAnchor: null,
      },
      {
        id: "cmt-orphaned-target",
        parentId: null,
        targetType: "TASK",
        targetId: "task-deleted",
        body: "Leftover note after parent removal",
        docAnchor: null,
      },
    ])
    mockPrisma.experiment.findMany.mockResolvedValue([
      { id: "exp-legacy", title: "Pricing page A/B test", seqPrefix: null, seqNumber: null },
    ])
    mockPrisma.task.findMany.mockResolvedValue([])

    const resolved = await resolveCommentLinks(WS, ["cmt-unnumbered", "cmt-orphaned-target"])
    expect(resolved.get("COMMENT:cmt-unnumbered")).toMatchObject({
      title: 'Comment on “Pricing page A/B test”: "Check sample size"',
      workspaceRelativePath: "experiments/exp-legacy?comment=cmt-unnumbered",
    })
    expect(resolved.get("COMMENT:cmt-orphaned-target")).toMatchObject({
      title: 'Comment on task: "Leftover note after parent removal"',
      workspaceRelativePath: null,
    })
  })
})
