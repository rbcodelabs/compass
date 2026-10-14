import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import { getMcpActivityPrisma as getPrisma } from "@/lib/analytics/activity"
import { fail, ok } from "@/lib/mcp-output"
import type { SolutionStatus } from "@/lib/types"
import { workspaceMutationSource, type ProgrammaticSource } from "@/lib/programmatic-source"
import { getMcpActor } from "@/lib/mcp-authz"
import { syncRoadmapOnSolutionChange } from "@/lib/roadmap/solution-sync"

export async function updateSolutionStatus({ solutionId, status, source }: {
  solutionId: string
  status: SolutionStatus
  source?: ProgrammaticSource
}) {
  const prisma = getPrisma()
  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true, status: true, workspaceId: true },
  })

  if (!solution) {
    return fail(`Solution "${solutionId}" not found.`)
  }

  const data = {
    id: solution.id,
    title: solution.title,
    previousStatus: solution.status,
    status,
  }

  if (solution.status === status) {
    return ok(`**"${solution.title}"** is already at ${status}.\nID: ${solution.id}`, data)
  }

  await captureWorkspaceMutation(prisma, "solution", "update", workspaceMutationSource(source), solutionId, tx => tx.solution.update({
    where: { id: solutionId },
    data: { status, updatedAt: new Date() },
  }))

  // Building auto-adds the solution to the roadmap and linked items follow the new status. Best-effort:
  // the status change has committed, so a sync problem is reported in the data, never thrown.
  let roadmap: Awaited<ReturnType<typeof syncRoadmapOnSolutionChange>> | null = null
  if (solution.workspaceId) {
    let userId: string | null = null
    try { userId = getMcpActor().userId ?? null } catch { userId = null }
    roadmap = await syncRoadmapOnSolutionChange(
      prisma,
      { source: source ?? "MCP", captureSource: workspaceMutationSource(source), userId },
      { solutionId, workspaceId: solution.workspaceId, previousStatus: solution.status, status },
    )
  }
  const added = roadmap?.autoAdded
  return ok(
    `**"${solution.title}"** moved from ${solution.status} → ${status}.\nID: ${solution.id}` +
      (added ? `\nAuto-added to the roadmap.\nRoadmap Item ID: ${added.itemId}` : ""),
    { ...data, ...(added ? { roadmapItemId: added.itemId } : {}) },
  )
}
