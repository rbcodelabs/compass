/**
 * Server helpers for the Solution <-> Key Result link surfaces (Phase 4B): the picker on the Solution panel and the
 * "Linked solutions" list on the Key Result panel.
 *
 * A preset only decides whether these surfaces are OFFERED (links.solToKr is not "hidden"); the data and the
 * authorization are identical across presets. So the queries are skipped for a preset that hides the surface
 * (CLASSIC reads nothing extra), and never change what a write may do. A missing link table is not handled here:
 * the link reads fail loudly with the database error.
 */
import type { AppPrismaClient } from "@/lib/db"
import { resolveThinkingModel, type ThinkingModelSource } from "./resolve"

/** Whether the workspace's preset offers the Solution <-> Key Result surfaces. */
export function offersSolutionToKrSurfaces(source: ThinkingModelSource | null | undefined): boolean {
  return resolveThinkingModel(source ?? {}).links.solToKr !== "hidden"
}

/** The thinking-model columns of one workspace, for a detail fetcher that does not already load them. */
export async function loadThinkingModelSource(prisma: AppPrismaClient, workspaceId: string): Promise<ThinkingModelSource> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { thinkingModel: true, thinkingModelLabels: true } })
  return row ?? {}
}
