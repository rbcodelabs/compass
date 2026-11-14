import { describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import {
  batchMayAffectChildRuns,
  deleteWorkspaceAgentChildRuns,
  listConversationChildRuns,
  loadChildAgentSummariesByConversation,
  resetAgentChildRunsAvailabilityCache,
  settleStrandedAgentChildRuns,
  syncAgentChildRunsForBatch,
} from "@/lib/agent-child-runs"

function agentEvent(content: unknown[], parentId?: string) {
  return {
    type: "agent",
    payloadJson: JSON.stringify({
      message: {
        ...(parentId ? { parent_tool_use_id: parentId } : {}),
        message: { content },
      },
    }),
  }
}

function createFakeChildRunDb() {
  const rows: Array<{
    id: string
    conversationId: string
    runId: string
    workspaceId: string
    nativeAgentId: string
    parentChildRunId: string | null
    parentNativeAgentId: string | null
    role: string
    description: string
    status: string
    currentActivity: string | null
    stepCount: number
    stepsJson: string | null
    resultSummary: string | null
    startedAt: Date
    finishedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }> = []

  return {
    rows,
    agentChildRun: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
        return rows.filter((r) => {
          if (!where) return true
          if (typeof where.runId === "string" && r.runId !== where.runId) return false
          if (typeof where.workspaceId === "string" && r.workspaceId !== where.workspaceId) return false
          if (typeof where.status === "string" && r.status !== where.status) return false
          if (typeof where.conversationId === "string" && r.conversationId !== where.conversationId) return false
          if (where.conversationId && typeof where.conversationId === "object" && "in" in (where.conversationId as object)) {
            const ids = (where.conversationId as { in: string[] }).in
            if (!ids.includes(r.conversationId)) return false
          }
          return true
        })
      }),
      create: vi.fn(async ({ data }: { data: (typeof rows)[number] }) => {
        if (rows.some((r) => r.runId === data.runId && r.nativeAgentId === data.nativeAgentId)) {
          const err = Object.assign(new Error("Unique violation"), { code: "P2002" })
          throw err
        }
        rows.push({ ...data })
        return { id: data.id }
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<(typeof rows)[number]> }) => {
        const idx = rows.findIndex((r) => r.id === where.id)
        if (idx >= 0) rows[idx] = { ...rows[idx], ...data }
        return { id: where.id }
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { runId: string; nativeAgentId: string }; data: Partial<(typeof rows)[number]> }) => {
        let count = 0
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].runId === where.runId && rows[i].nativeAgentId === where.nativeAgentId) {
            rows[i] = { ...rows[i], ...data }
            count++
          }
        }
        return { count }
      }),
      deleteMany: vi.fn(async ({ where }: { where: { workspaceId: string } }) => {
        const before = rows.length
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].workspaceId === where.workspaceId) rows.splice(i, 1)
        }
        return { count: before - rows.length }
      }),
    } as unknown as AppPrismaClient["agentChildRun"],
  }
}

describe("agent-child-runs server projection and queries", () => {
  it("skips batches that contain only text deltas or top-level non-subagent tool uses", () => {
    expect(batchMayAffectChildRuns([{ type: "status", payloadJson: "{}" }])).toEqual({
      mayAffect: false,
      hasSubagentSpawn: false,
    })
    expect(
      batchMayAffectChildRuns([
        agentEvent([{ type: "text", text: "Hello" }]),
        agentEvent([{ type: "tool_use", id: "t1", name: "mcp__compass__list_tasks", input: {} }]),
      ]),
    ).toEqual({ mayAffect: false, hasSubagentSpawn: false })
  })

  it("projects top-level and nested sub-agents, records tool steps idempotently, and settles on tool_result", async () => {
    const db = createFakeChildRunDb()
    const now = new Date("2026-11-14T01:00:00.000Z")

    const batch1 = [
      agentEvent([
        {
          type: "tool_use",
          id: "sub-parent",
          name: "Task",
          input: { subagent_type: "Architect", description: "Design child-run tree" },
        },
      ]),
      agentEvent(
        [
          { type: "tool_use", id: "step-1", name: "mcp__compass__list_docs", input: { query: "agent" } },
          {
            type: "tool_use",
            id: "sub-nested",
            name: "Agent",
            input: { subagent_type: "SQL Reviewer", description: "Check DSQL rules" },
          },
        ],
        "sub-parent",
      ),
    ]

    await syncAgentChildRunsForBatch(db, {
      runId: "run-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      events: batch1,
      now,
    })

    expect(db.rows).toHaveLength(2)
    const parentRow = db.rows.find((r) => r.nativeAgentId === "sub-parent")!
    const nestedRow = db.rows.find((r) => r.nativeAgentId === "sub-nested")!
    expect(parentRow).toMatchObject({
      role: "Architect",
      description: "Design child-run tree",
      status: "RUNNING",
      stepCount: 1,
      currentActivity: "List docs · query: agent",
    })
    expect(nestedRow).toMatchObject({
      parentChildRunId: parentRow.id,
      parentNativeAgentId: "sub-parent",
      role: "SQL Reviewer",
      status: "RUNNING",
    })

    // Replaying the same batch is idempotent (stepCount does not double)
    await syncAgentChildRunsForBatch(db, {
      runId: "run-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      events: batch1,
      now,
    })
    expect(db.rows).toHaveLength(2)
    expect(db.rows.find((r) => r.nativeAgentId === "sub-parent")!.stepCount).toBe(1)

    // Settle nested sub-agent with error and parent sub-agent with success
    const settledNow = new Date("2026-11-14T01:02:00.000Z")
    await syncAgentChildRunsForBatch(db, {
      runId: "run-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      events: [
        agentEvent(
          [
            { type: "tool_result", tool_use_id: "step-1", content: "Found 2 docs" },
            { type: "tool_result", tool_use_id: "sub-nested", is_error: true, content: "Index missing ASYNC" },
          ],
          "sub-parent",
        ),
        agentEvent([{ type: "tool_result", tool_use_id: "sub-parent", content: "Architecture verified and updated." }]),
      ],
      now: settledNow,
    })

    expect(db.rows.find((r) => r.nativeAgentId === "sub-nested")).toMatchObject({
      status: "FAILED",
      resultSummary: "Index missing ASYNC",
      finishedAt: settledNow,
    })
    expect(db.rows.find((r) => r.nativeAgentId === "sub-parent")).toMatchObject({
      status: "SUCCEEDED",
      currentActivity: null,
      resultSummary: "Architecture verified and updated.",
      finishedAt: settledNow,
    })

    // Batch summary for board cards
    const summaryMap = await loadChildAgentSummariesByConversation(db, "ws-1", ["conv-1"])
    expect(summaryMap.get("conv-1")).toEqual({
      total: 2,
      active: 0,
      failed: 1,
      roles: ["Architect", "SQL Reviewer"],
    })
  })

  it("redacts descriptions, step details, and summaries on claimed handoff runs", async () => {
    const db = createFakeChildRunDb()
    await syncAgentChildRunsForBatch(db, {
      runId: "run-claim",
      conversationId: "conv-claim",
      workspaceId: "ws-1",
      redactArgs: true,
      events: [
        agentEvent([{ type: "tool_use", id: "s1", name: "Task", input: { description: "Secret interview transcript" } }]),
        agentEvent([{ type: "tool_use", id: "st1", name: "mcp__compass__write_doc", input: { title: "Private" } }], "s1"),
        agentEvent([{ type: "tool_result", tool_use_id: "s1", content: "Sensitive synthesis" }]),
      ],
    })
    expect(db.rows[0].description).toBe("Delegated sub-agent")
    expect(db.rows[0].resultSummary).toBeNull()
    expect(JSON.parse(db.rows[0].stepsJson!)).toEqual([{ id: "st1", label: "Write doc", status: "done" }])
  })

  it("settles stranded RUNNING child runs when the parent AgentRun terminates", async () => {
    const db = createFakeChildRunDb()
    await syncAgentChildRunsForBatch(db, {
      runId: "run-timeout",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      events: [
        agentEvent([{ type: "tool_use", id: "s1", name: "Task", input: { description: "Long task" } }]),
        agentEvent([{ type: "tool_use", id: "st1", name: "web_search", input: { query: "dsql" } }], "s1"),
      ],
    })

    await settleStrandedAgentChildRuns(db, {
      runId: "run-timeout",
      terminalRunStatus: "INTERRUPTED",
      now: new Date("2026-11-14T02:00:00.000Z"),
    })

    expect(db.rows[0].status).toBe("INTERRUPTED")
    expect(db.rows[0].currentActivity).toBeNull()
    expect(JSON.parse(db.rows[0].stepsJson!)[0].status).toBe("done")
  })

  it("enforces conversation access on listConversationChildRuns and tolerates P2021 pre-migration", async () => {
    resetAgentChildRunsAvailabilityCache()
    const missingTableErr = Object.assign(new Error("relation does not exist"), { code: "P2021" })
    const unmigratedDb = {
      agentConversation: {
        findFirst: vi.fn().mockResolvedValue({ id: "conv-1", userId: "u-1", workspaceId: "ws-1" }),
      },
      workspaceMember: {
        findFirst: vi.fn().mockResolvedValue({ id: "m-1" }),
      },
      agentConversationParticipant: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      agentChildRun: {
        findMany: vi.fn().mockRejectedValue(missingTableErr),
        create: vi.fn().mockRejectedValue(missingTableErr),
        update: vi.fn().mockRejectedValue(missingTableErr),
        updateMany: vi.fn().mockRejectedValue(missingTableErr),
        deleteMany: vi.fn().mockRejectedValue(missingTableErr),
      },
    }

    await expect(
      listConversationChildRuns(unmigratedDb as never, {
        conversationId: "conv-1",
        workspaceId: "ws-1",
        userId: "u-1",
      }),
    ).resolves.toEqual([])

    // Non-member receives null (404)
    unmigratedDb.agentConversation.findFirst.mockResolvedValueOnce(null)
    await expect(
      listConversationChildRuns(unmigratedDb as never, {
        conversationId: "conv-1",
        workspaceId: "ws-1",
        userId: "outsider",
      }),
    ).resolves.toBeNull()

    await expect(deleteWorkspaceAgentChildRuns(unmigratedDb as never, "ws-1")).resolves.toBeUndefined()
  })
})
