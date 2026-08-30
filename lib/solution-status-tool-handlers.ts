import getPrisma from "@/lib/db"
import { fail, ok } from "@/lib/mcp-output"
import type { SolutionStatus } from "@/lib/types"

export async function updateSolutionStatus({ solutionId, status }: {
  solutionId: string
  status: SolutionStatus
}) {
  const prisma = getPrisma()
  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true, status: true },
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

  await prisma.solution.update({
    where: { id: solutionId },
    data: { status, updatedAt: new Date() },
  })

  return ok(`**"${solution.title}"** moved from ${solution.status} → ${status}.\nID: ${solution.id}`, data)
}
