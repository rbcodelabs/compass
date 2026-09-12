import getPrisma from "@/lib/db"
import { ok } from "@/lib/mcp-output"
import { recencyOrderBy, type RecencySort } from "@/lib/mcp-recency"

type OpportunityStatus = "EXPLORING" | "VALIDATING" | "PRIORITIZED" | "ACTIVE" | "ARCHIVED"
type SolutionStatus = "IDEA" | "VALIDATED" | "IN_DELIVERY" | "SHIPPED" | "KILLED"
type AssumptionStatus = "UNTESTED" | "TESTING" | "VALIDATED" | "INVALIDATED"
type RiskLevel = "HIGH" | "MEDIUM" | "LOW"

export async function listSolutions({
  workspaceId,
  status,
  opportunityStatus,
  squadId,
  hasRoadmapItem,
  updatedSince,
  updatedBefore,
  sort,
}: {
  workspaceId: string
  status?: SolutionStatus
  opportunityStatus?: OpportunityStatus
  squadId?: string
  hasRoadmapItem?: boolean
  updatedSince?: string
  updatedBefore?: string
  sort?: RecencySort
}) {
  const solutions = await getPrisma().solution.findMany({
    where: {
      ...(status ? { status } : {}),
      opportunity: {
        workspaceId,
        ...(opportunityStatus ? { status: opportunityStatus } : {}),
        ...(squadId ? { squadId } : {}),
      },
      ...(hasRoadmapItem === true ? { roadmapItems: { some: {} } } : {}),
      ...(hasRoadmapItem === false ? { roadmapItems: { none: {} } } : {}),
      ...(updatedSince || updatedBefore
        ? {
            updatedAt: {
              ...(updatedSince ? { gte: new Date(updatedSince) } : {}),
              ...(updatedBefore ? { lt: new Date(updatedBefore) } : {}),
            },
          }
        : {}),
    },
    include: {
      opportunity: { select: { id: true, title: true, status: true, squadId: true } },
      roadmapItems: {
        select: { id: true, horizon: true, status: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: recencyOrderBy(sort) ?? [{ updatedAt: "asc" }, { id: "asc" }],
  })

  const items = solutions.map((solution) => ({
    id: solution.id,
    title: solution.title,
    status: solution.status,
    opportunityId: solution.opportunityId,
    opportunityTitle: solution.opportunity.title,
    opportunityStatus: solution.opportunity.status,
    squadId: solution.opportunity.squadId,
    roadmapItems: solution.roadmapItems,
    createdAt: solution.createdAt,
    updatedAt: solution.updatedAt,
  }))
  const message = items.length
    ? items.map((item) =>
      `• **${item.title}** [${item.status}] — ID: ${item.id}\n` +
      `  Opportunity: ${item.opportunityTitle} [${item.opportunityStatus}] — ID: ${item.opportunityId}` +
      (item.roadmapItems.length ? `\n  Roadmap items: ${item.roadmapItems.map((roadmap) => roadmap.id).join(", ")}` : ""),
    ).join("\n")
    : "No solutions found."
  return ok(message, { items, count: items.length })
}

export async function listAssumptions({
  workspaceId,
  status,
  riskLevel,
  solutionStatus,
  opportunityStatus,
  squadId,
  updatedSince,
  updatedBefore,
  sort,
}: {
  workspaceId: string
  status?: AssumptionStatus
  riskLevel?: RiskLevel
  solutionStatus?: SolutionStatus
  opportunityStatus?: OpportunityStatus
  squadId?: string
  updatedSince?: string
  updatedBefore?: string
  sort?: RecencySort
}) {
  const assumptions = await getPrisma().assumption.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(riskLevel ? { riskLevel } : {}),
      solution: {
        ...(solutionStatus ? { status: solutionStatus } : {}),
        opportunity: {
          workspaceId,
          ...(opportunityStatus ? { status: opportunityStatus } : {}),
          ...(squadId ? { squadId } : {}),
        },
      },
      ...(updatedSince || updatedBefore
        ? {
            updatedAt: {
              ...(updatedSince ? { gte: new Date(updatedSince) } : {}),
              ...(updatedBefore ? { lt: new Date(updatedBefore) } : {}),
            },
          }
        : {}),
    },
    include: {
      solution: {
        select: {
          id: true,
          title: true,
          status: true,
          opportunity: { select: { id: true, title: true, status: true, squadId: true } },
        },
      },
      _count: { select: { experiments: true } },
    },
    orderBy: recencyOrderBy(sort) ?? [{ updatedAt: "asc" }, { id: "asc" }],
  })

  const items = assumptions.map((assumption) => ({
    id: assumption.id,
    title: assumption.title,
    status: assumption.status,
    riskLevel: assumption.riskLevel,
    solutionId: assumption.solutionId,
    solutionTitle: assumption.solution.title,
    solutionStatus: assumption.solution.status,
    opportunityId: assumption.solution.opportunity.id,
    opportunityTitle: assumption.solution.opportunity.title,
    opportunityStatus: assumption.solution.opportunity.status,
    squadId: assumption.solution.opportunity.squadId,
    experimentCount: assumption._count.experiments,
    createdAt: assumption.createdAt,
    updatedAt: assumption.updatedAt,
  }))
  const message = items.length
    ? items.map((item) =>
      `• **${item.title}** [${item.status}/${item.riskLevel}] — ID: ${item.id}\n` +
      `  Solution: ${item.solutionTitle} [${item.solutionStatus}] — ID: ${item.solutionId}\n` +
      `  Opportunity: ${item.opportunityTitle} [${item.opportunityStatus}] — ID: ${item.opportunityId}\n` +
      `  Experiments: ${item.experimentCount}`,
    ).join("\n")
    : "No assumptions found."
  return ok(message, { items, count: items.length })
}
