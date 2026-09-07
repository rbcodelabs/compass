import getPrisma from "@/lib/db"
import { ok } from "@/lib/mcp-output"

type ReleaseRunState =
  | "PREPARING"
  | "READY_FOR_APPROVAL"
  | "DISPATCH_QUEUED"
  | "BLOCKED"
  | "SUPERSEDED"
  | "CANCELLED"

export async function listReleaseRuns({
  workspaceId,
  state,
  taskId,
  updatedSince,
}: {
  workspaceId: string
  state?: ReleaseRunState
  taskId?: string
  updatedSince?: string
}) {
  const runs = await getPrisma().releaseRun.findMany({
    where: {
      workspaceId,
      ...(state ? { state } : {}),
      ...(taskId ? { tasks: { some: { taskId } } } : {}),
      ...(updatedSince ? { updatedAt: { gte: new Date(updatedSince) } } : {}),
    },
    include: {
      tasks: { select: { taskId: true } },
      dispatches: {
        select: { id: true, status: true, updatedAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  })

  const items = runs.map((run) => ({
    id: run.id,
    state: run.state,
    provider: run.provider,
    repositoryOwner: run.repositoryOwner,
    repositoryName: run.repositoryName,
    pullRequestNumber: run.pullRequestNumber,
    pullRequestUrl: `https://github.com/${run.repositoryOwner}/${run.repositoryName}/pull/${run.pullRequestNumber}`,
    baseRef: run.baseRef,
    headSha: run.headSha,
    targetEnvironment: run.targetEnvironment,
    releasePolicyId: run.releasePolicyId,
    sourceFingerprint: run.sourceFingerprint,
    authorizationDecisionRecordId: run.authorizationDecisionRecordId,
    taskIds: run.tasks.map((task) => task.taskId),
    dispatches: run.dispatches,
    lastErrorCode: run.lastErrorCode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }))
  const message = items.length
    ? items.map((item) =>
      `• **${item.repositoryOwner}/${item.repositoryName} PR #${item.pullRequestNumber}** [${item.state}]\n` +
      `  ID: ${item.id}\n` +
      `  Head: ${item.headSha}\n` +
      `  Tasks: ${item.taskIds.join(", ")}\n` +
      `  URL: ${item.pullRequestUrl}`,
    ).join("\n\n")
    : "No release runs found."
  return ok(message, { items, count: items.length })
}
