import { getToolPrisma, getToolExpectedWhere } from "@/lib/mcp-tool-db"
import { fail, ok } from "@/lib/mcp-output"

export async function updateExperiment({ experimentId, expectedUpdatedAt, title, hypothesis, method, killCondition }: { experimentId: string; expectedUpdatedAt?: string; title?: string; hypothesis?: string; method?: string; killCondition?: string }) {
  const prisma = getToolPrisma()
  const existing = await prisma.experiment.findUnique({ where: { id: experimentId } })
  if (!existing || existing.status !== "DESIGNING") return fail("Only designing experiments can be edited")
  const data = Object.fromEntries(Object.entries({ title, hypothesis, method, killCondition }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, value!.trim()]))
  if (!Object.keys(data).length || Object.values(data).some(value => !value)) return fail("Provide non-empty experiment fields")
  const updated = await prisma.experiment.update({ where: { id: experimentId, status: "DESIGNING", ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}), ...getToolExpectedWhere() }, data: { ...data, updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)) } })
  return ok(`Experiment updated\nID: ${updated.id}`, { id: updated.id, title: updated.title, hypothesis: updated.hypothesis, method: updated.method, killCondition: updated.killCondition, updatedAt: updated.updatedAt })
}
