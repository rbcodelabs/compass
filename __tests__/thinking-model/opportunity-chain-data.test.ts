import { describe, expect, it, vi } from "vitest"

const { getLinkedKeyResultsBySolution } = vi.hoisted(() => ({
  getLinkedKeyResultsBySolution: vi.fn(async () => new Map([["s1", [{ id: "kr-1", title: "KR", objectiveId: "obj-2" }]]])),
}))
vi.mock("@/lib/typed-links", () => ({ getLinkedKeyResultsBySolution }))
import { loadOpportunityChainExtras } from "@/lib/thinking-model/opportunity-chain-data"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

const fakePrisma = () => {
  const taskLink = { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [{ linkedId: "s1", createdAt: new Date(), task: { id: "t1", title: "T", status: "TODO" } }]) }
  const objective = { findMany: vi.fn(async (_args: { where: { id: { in: string[] } } & Record<string, unknown> }) => [{ id: "obj-1", title: "O1", keyResults: [] }]) }
  return { prisma: { taskLink, objective } as never, taskLink, objective }
}
const opportunity = { linkedObjectives: [{ id: "obj-1" }], linkedKeyResult: { objective: { id: "obj-3" } } }

describe("loadOpportunityChainExtras", () => {
  it("scopes every read to the workspace and batches by id (no per-solution queries)", async () => {
    getLinkedKeyResultsBySolution.mockClear()
    const { prisma, taskLink, objective } = fakePrisma()
    const out = await loadOpportunityChainExtras(prisma, "ws-1", resolveThinkingModel({ thinkingModel: "TORRES_OST" }), opportunity, [{ id: "s1" }, { id: "s2" }])
    expect(taskLink.findMany).toHaveBeenCalledTimes(1)
    expect(taskLink.findMany.mock.calls[0][0].where).toMatchObject({ linkedType: "SOLUTION", linkedId: { in: ["s1", "s2"] }, task: { workspaceId: "ws-1" } })
    expect(objective.findMany).toHaveBeenCalledTimes(1)
    expect(objective.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws-1" })
    expect([...objective.findMany.mock.calls[0][0].where.id.in].sort()).toEqual(["obj-1", "obj-2", "obj-3"])
    expect(getLinkedKeyResultsBySolution).toHaveBeenCalledWith(prisma, "ws-1", ["s1", "s2"], { preverified: true })
    expect(out.tasksBySolution.get("s1")).toEqual([{ id: "t1", title: "T", status: "TODO" }])
  })

  it("CLASSIC reads no typed Solution links and no Objectives", async () => {
    getLinkedKeyResultsBySolution.mockClear()
    const { prisma, objective } = fakePrisma()
    const out = await loadOpportunityChainExtras(prisma, "ws-1", resolveThinkingModel({}), opportunity, [{ id: "s1" }])
    expect(getLinkedKeyResultsBySolution).not.toHaveBeenCalled()
    expect(objective.findMany).not.toHaveBeenCalled()
    expect(out.chainObjectives).toEqual([])
  })

  it("reads nothing for an opportunity with no solutions", async () => {
    const { prisma, taskLink } = fakePrisma()
    await loadOpportunityChainExtras(prisma, "ws-1", resolveThinkingModel({ thinkingModel: "OPPORTUNITY_FIRST_OKR" }), { linkedObjectives: [], linkedKeyResult: null }, [])
    expect(taskLink.findMany).not.toHaveBeenCalled()
  })
})
