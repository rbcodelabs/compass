import { describe, expect, it } from "vitest"
import {
  agentLabel,
  agentSubLabel,
  buildAgentBreadcrumbs,
  flattenAgentTree,
  listDirectChildRuns,
  mergeChildAgentRuns,
  summarizeAgentTeam,
  type SerializedChildAgentRun,
} from "@/lib/agent/child-agent-tree"

function makeChild(overrides: Partial<SerializedChildAgentRun> & { id: string }): SerializedChildAgentRun {
  return {
    conversationId: "conv-1",
    runId: "run-1",
    nativeAgentId: `tool-${overrides.id}`,
    parentChildRunId: null,
    parentNativeAgentId: null,
    role: "general-purpose",
    description: `Task ${overrides.id}`,
    status: "SUCCEEDED",
    currentActivity: null,
    stepCount: 0,
    steps: [],
    resultSummary: null,
    startedAt: "2026-11-14T00:00:00.000Z",
    finishedAt: "2026-11-14T00:01:00.000Z",
    updatedAt: "2026-11-14T00:01:00.000Z",
    ...overrides,
  }
}

describe("child-agent-tree pure helpers", () => {
  it("flattens nested parent/child runs depth-first and falls back to parentNativeAgentId", () => {
    const rootA = makeChild({ id: "a", nativeAgentId: "nat-a", role: "Lead Researcher", description: "Survey repo" })
    const childA1 = makeChild({ id: "a1", nativeAgentId: "nat-a1", parentChildRunId: "a", role: "Explore", description: "Read schema" })
    const grandChild = makeChild({
      id: "a1x",
      nativeAgentId: "nat-a1x",
      parentChildRunId: null,
      parentNativeAgentId: "nat-a1",
      role: "SQL Verifier",
      description: "Check DSQL indexes",
    })
    const rootB = makeChild({ id: "b", nativeAgentId: "nat-b", role: "Test Runner", description: "Run vitest" })

    const rows = flattenAgentTree([rootA, rootB, childA1, grandChild])
    expect(rows.map((r) => [r.run.id, r.level])).toEqual([
      ["a", 1],
      ["a1", 2],
      ["a1x", 3],
      ["b", 1],
    ])

    expect(listDirectChildRuns([rootA, rootB, childA1, grandChild], "a").map((r) => r.id)).toEqual(["a1"])
    expect(listDirectChildRuns([rootA, rootB, childA1, grandChild], "a1").map((r) => r.id)).toEqual(["a1x"])
  })

  it("promotes orphans, self-parents, and multi-node cycles to roots without infinite loops", () => {
    const orphan = makeChild({ id: "orphan", parentChildRunId: "missing-parent" })
    const selfParent = makeChild({ id: "self", parentChildRunId: "self" })
    const cyc1 = makeChild({ id: "c1", parentChildRunId: "c3" })
    const cyc2 = makeChild({ id: "c2", parentChildRunId: "c1" })
    const cyc3 = makeChild({ id: "c3", parentChildRunId: "c2" })

    const rows = flattenAgentTree([orphan, selfParent, cyc1, cyc2, cyc3])
    expect(rows.map((r) => [r.run.id, r.level])).toEqual([
      ["orphan", 1],
      ["self", 1],
      ["c1", 1],
      ["c2", 1],
      ["c3", 1],
    ])

    expect(buildAgentBreadcrumbs([cyc1, cyc2, cyc3], "c2").map((r) => r.id)).toEqual(["c2"])
  })

  it("builds root-to-leaf ancestor breadcrumbs cleanly", () => {
    const p1 = makeChild({ id: "p1", role: "Architect" })
    const p2 = makeChild({ id: "p2", parentChildRunId: "p1", role: "Implementer" })
    const p3 = makeChild({ id: "p3", parentChildRunId: "p2", role: "Reviewer" })

    expect(buildAgentBreadcrumbs([p1, p2, p3], "p3").map((r) => r.id)).toEqual(["p1", "p2", "p3"])
    expect(buildAgentBreadcrumbs([p1, p2, p3], "unknown")).toEqual([])
    expect(buildAgentBreadcrumbs([p1, p2, p3], null)).toEqual([])
  })

  it("summarizes active, failed, and settled sub-agent teams", () => {
    expect(summarizeAgentTeam([])).toEqual({ total: 0, active: 0, failed: 0, label: "No agents", tone: "idle" })

    const activeTeam = summarizeAgentTeam([
      makeChild({ id: "1", status: "RUNNING" }),
      makeChild({ id: "2", status: "RUNNING" }),
      makeChild({ id: "3", status: "SUCCEEDED" }),
    ])
    expect(activeTeam).toEqual({ total: 3, active: 2, failed: 0, label: "2 agents working", tone: "active" })

    const failedTeam = summarizeAgentTeam([
      makeChild({ id: "1", status: "FAILED" }),
      makeChild({ id: "2", status: "SUCCEEDED" }),
    ])
    expect(failedTeam).toEqual({ total: 2, active: 0, failed: 1, label: "1 agent failed", tone: "failed" })

    const doneTeam = summarizeAgentTeam([
      makeChild({ id: "1", status: "SUCCEEDED" }),
      makeChild({ id: "2", status: "SUCCEEDED" }),
    ])
    expect(doneTeam).toEqual({ total: 2, active: 0, failed: 0, label: "2 agents", tone: "done" })
  })

  it("chooses smart labels and secondary labels for generic vs custom roles", () => {
    const generic = makeChild({
      id: "g",
      role: "general-purpose",
      description: "Audit DSQL migrations",
      status: "RUNNING",
      currentActivity: "Read file · path: runner.ts",
    })
    expect(agentLabel(generic)).toBe("Audit DSQL migrations")
    expect(agentSubLabel(generic)).toBe("Read file · path: runner.ts")

    const custom = makeChild({
      id: "c",
      role: "Security Auditor",
      description: "Verify OAuth token scopes",
      status: "SUCCEEDED",
    })
    expect(agentLabel(custom)).toBe("Security Auditor")
    expect(agentSubLabel(custom)).toBe("Verify OAuth token scopes")
  })

  it("overlays live client-streamed subagents onto durable rows by (runId, nativeAgentId)", () => {
    const durable = [
      makeChild({
        id: "db-1",
        runId: "run-live",
        nativeAgentId: "sub-1",
        role: "Explore",
        description: "Find routes",
        status: "RUNNING",
        stepCount: 1,
        steps: [{ id: "st-1", label: "Glob", status: "done" }],
      }),
    ]

    const merged = mergeChildAgentRuns({
      durableRuns: durable,
      conversationId: "conv-1",
      activeRunId: "run-live",
      liveSubagents: [
        {
          id: "sub-1",
          agentType: "Explore",
          description: "Find routes",
          status: "running",
          steps: [
            { id: "st-1", label: "Glob", status: "done" },
            { id: "st-2", label: "Read", status: "running", detail: "path: app/api" },
          ],
        },
        {
          id: "sub-2",
          parentToolUseId: "sub-1",
          agentType: "Verifier",
          description: "Verify auth checks",
          status: "running",
          steps: [],
        },
      ],
      nowIso: "2026-11-14T00:05:00.000Z",
    })

    expect(merged).toHaveLength(2)
    expect(merged[0].id).toBe("db-1")
    expect(merged[0].stepCount).toBe(2)
    expect(merged[0].currentActivity).toBe("Read · path: app/api")
    expect(merged[1]).toMatchObject({
      id: "live:run-live:sub-2",
      nativeAgentId: "sub-2",
      parentNativeAgentId: "sub-1",
      role: "Verifier",
      status: "RUNNING",
    })
    expect(flattenAgentTree(merged).map((r) => [r.run.id, r.level])).toEqual([
      ["db-1", 1],
      ["live:run-live:sub-2", 2],
    ])
  })
})
