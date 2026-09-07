import { beforeEach, describe, expect, it, vi } from "vitest"

const mockReleaseRun = { findMany: vi.fn() }
vi.mock("@/lib/db", () => ({ default: () => ({ releaseRun: mockReleaseRun }) }))

import { listReleaseRuns } from "@/lib/release-query-tool-handlers"

beforeEach(() => vi.clearAllMocks())

describe("listReleaseRuns", () => {
  it("returns stable PR, commit, task, authorization, and dispatch identities", async () => {
    const updatedAt = new Date("2026-09-06T00:00:00.000Z")
    mockReleaseRun.findMany.mockResolvedValueOnce([
      {
        id: "release-1",
        state: "DISPATCH_QUEUED",
        provider: "GITHUB",
        repositoryOwner: "rbcodelabs",
        repositoryName: "compass",
        pullRequestNumber: 159,
        baseRef: "main",
        headSha: "a".repeat(40),
        targetEnvironment: "PRODUCTION",
        releasePolicyId: "default",
        sourceFingerprint: "b".repeat(64),
        authorizationDecisionRecordId: "decision-1",
        lastErrorCode: null,
        createdAt: new Date("2026-09-05T00:00:00.000Z"),
        updatedAt,
        tasks: [{ taskId: "task-1" }],
        dispatches: [{ id: "dispatch-1", status: "PENDING", updatedAt }],
      },
    ])

    const result = await listReleaseRuns({
      workspaceId: "workspace-1",
      state: "DISPATCH_QUEUED",
      taskId: "task-1",
      updatedSince: "2026-09-01T00:00:00.000Z",
    })

    expect(mockReleaseRun.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        state: "DISPATCH_QUEUED",
        tasks: { some: { taskId: "task-1" } },
        updatedAt: { gte: new Date("2026-09-01T00:00:00.000Z") },
      },
      include: {
        tasks: { select: { taskId: true } },
        dispatches: { select: { id: true, status: true, updatedAt: true }, orderBy: { createdAt: "desc" } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    })
    expect(result.structuredContent.data).toEqual({
      items: [
        expect.objectContaining({
          id: "release-1",
          state: "DISPATCH_QUEUED",
          repositoryOwner: "rbcodelabs",
          repositoryName: "compass",
          pullRequestNumber: 159,
          headSha: "a".repeat(40),
          authorizationDecisionRecordId: "decision-1",
          taskIds: ["task-1"],
          dispatches: [{ id: "dispatch-1", status: "PENDING", updatedAt }],
        }),
      ],
      count: 1,
    })
    const item = (result.structuredContent.data as { items: Array<Record<string, unknown>> }).items[0]
    expect(item).not.toHaveProperty("merged")
    expect(item).not.toHaveProperty("productionVerified")
  })

  it("returns an empty successful collection", async () => {
    mockReleaseRun.findMany.mockResolvedValueOnce([])
    const result = await listReleaseRuns({ workspaceId: "workspace-1" })
    expect(result.structuredContent).toMatchObject({ ok: true, data: { items: [], count: 0 } })
  })
})
