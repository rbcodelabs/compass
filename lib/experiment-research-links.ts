import getPrisma from "@/lib/db"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import type { ResearchStudyActor, ResearchWorkspaceScope } from "@/lib/research-study-service"

export class ExperimentResearchLinkError extends Error {}
export type ExperimentStudyPair = { experimentId: string; studyId: string }
export type ResearchLinkTarget = { type: "experiment" | "study"; id: string }
export type LinkedResearchRecord = { id: string; title: string; status: string }
export type ResearchLinksData = { linked: LinkedResearchRecord[]; available: LinkedResearchRecord[]; canLink: boolean }

const studyTypes = ["CUSTOMER_INTERVIEW", "USABILITY_TEST"]

function requireId(value: unknown) {
  // Internal callers pass typed IDs; reject omitted/empty runtime input before
  // Prisma can interpret undefined as an omitted query filter.
  if (typeof value !== "string" || !value.trim()) throw new ExperimentResearchLinkError("Invalid identifier")
}

async function workspaceAccess(scope: ResearchWorkspaceScope, actor: ResearchStudyActor) {
  if ("workspaceId" in scope) requireId(scope.workspaceId)
  else { requireId(scope.orgSlug); requireId(scope.workspaceSlug) }
  if (!isResearchCaptureEnabled()) throw new ExperimentResearchLinkError("Research capture is not enabled")
  if (!actor.userId && !(actor.service === true && actor.userId === null)) throw new ExperimentResearchLinkError("Unauthorized")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: {
      ...("workspaceId" in scope ? { id: scope.workspaceId } : { slug: scope.workspaceSlug, organization: { slug: scope.orgSlug } }),
      ...(actor.userId ? { members: { some: { userId: actor.userId } } } : {}),
    },
    select: { id: true },
  })
  if (!workspace) throw new ExperimentResearchLinkError("Workspace not found")
  return { prisma, workspaceId: workspace.id }
}

async function endpoints(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, pair: ExperimentStudyPair) {
  requireId(pair.experimentId)
  requireId(pair.studyId)
  const { prisma, workspaceId } = await workspaceAccess(scope, actor)
  const [experiment, study] = await Promise.all([
    prisma.experiment.findFirst({ where: { id: pair.experimentId, workspaceId }, select: { id: true } }),
    prisma.researchStudy.findFirst({ where: { id: pair.studyId, workspaceId, studyType: { in: studyTypes } }, select: { id: true, status: true } }),
  ])
  if (!experiment || !study) throw new ExperimentResearchLinkError("Experiment or study not found")
  return { prisma, workspaceId, study }
}

export async function linkExperimentResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, pair: ExperimentStudyPair) {
  const { prisma, workspaceId, study } = await endpoints(scope, actor, pair)
  const existing = await prisma.experimentResearchStudyLink.findFirst({ where: { workspaceId, ...pair }, select: { id: true } })
  if (existing) return { ...pair, changed: false }
  if (study.status === "ARCHIVED") throw new ExperimentResearchLinkError("Archived studies cannot be linked")
  try {
    await prisma.experimentResearchStudyLink.create({ data: { workspaceId, ...pair, createdById: actor.userId, source: actor.source ?? "UI" } })
  } catch (error) {
    // The unique pair constraint resolves concurrent requests without changing
    // either endpoint's lifecycle, protocol, or update timestamp.
    if ((error as { code?: string }).code !== "P2002") throw error
    const winner = await prisma.experimentResearchStudyLink.findFirst({ where: { workspaceId, ...pair }, select: { id: true } })
    if (!winner) throw error
    return { ...pair, changed: false }
  }
  return { ...pair, changed: true }
}

export async function unlinkExperimentResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, pair: ExperimentStudyPair) {
  const { prisma, workspaceId } = await endpoints(scope, actor, pair)
  const result = await prisma.experimentResearchStudyLink.deleteMany({ where: { workspaceId, ...pair } })
  return { ...pair, changed: result.count > 0 }
}

/** Internal read projections: callers first authorize their workspace/endpoint.
 * Query the endpoint itself so missing, foreign, and PM-only records are omitted. */
export async function getExperimentResearchStudies(workspaceId: string, experimentId: string) {
  if (!isResearchCaptureEnabled()) return []
  return getPrisma().researchStudy.findMany({
    where: { workspaceId, studyType: { in: studyTypes }, experimentLinks: { some: { workspaceId, experimentId } } },
    select: { id: true, name: true, status: true }, orderBy: [{ name: "asc" }, { id: "asc" }],
  })
}

export async function getStudyExperiments(workspaceId: string, studyId: string) {
  if (!isResearchCaptureEnabled()) return []
  return getPrisma().experiment.findMany({
    where: { workspaceId, researchStudyLinks: { some: { workspaceId, studyId } } },
    select: { id: true, title: true, status: true }, orderBy: [{ title: "asc" }, { id: "asc" }],
  })
}

export async function getResearchLinks(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, target: ResearchLinkTarget, search = ""): Promise<ResearchLinksData> {
  requireId(target.id)
  if (target.type !== "experiment" && target.type !== "study") throw new ExperimentResearchLinkError("Invalid target")
  const { prisma, workspaceId } = await workspaceAccess(scope, actor)
  const query = search.trim().slice(0, 255)
  if (target.type === "experiment") {
    const experiment = await prisma.experiment.findFirst({ where: { id: target.id, workspaceId }, select: { id: true } })
    if (!experiment) throw new ExperimentResearchLinkError("Experiment not found")
    const [linked, available] = await Promise.all([
      getExperimentResearchStudies(workspaceId, target.id),
      prisma.researchStudy.findMany({
        where: { workspaceId, studyType: { in: studyTypes }, status: { not: "ARCHIVED" }, name: { contains: query, mode: "insensitive" }, experimentLinks: { none: { workspaceId, experimentId: target.id } } },
        select: { id: true, name: true, status: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 50,
      }),
    ])
    const named = (record: { id: string; name: string; status: string }) => ({ id: record.id, title: record.name, status: record.status })
    return { linked: linked.map(named), available: available.map(named), canLink: true }
  }
  const study = await prisma.researchStudy.findFirst({ where: { id: target.id, workspaceId, studyType: { in: studyTypes } }, select: { id: true, status: true } })
  if (!study) throw new ExperimentResearchLinkError("Study not found")
  const [linked, available] = await Promise.all([
    getStudyExperiments(workspaceId, target.id),
    study.status === "ARCHIVED" ? [] : prisma.experiment.findMany({
      where: { workspaceId, title: { contains: query, mode: "insensitive" }, researchStudyLinks: { none: { workspaceId, studyId: target.id } } },
      select: { id: true, title: true, status: true }, orderBy: [{ title: "asc" }, { id: "asc" }], take: 50,
    }),
  ])
  return { linked, available, canLink: study.status !== "ARCHIVED" }
}
