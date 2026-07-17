/**
 * Handler functions for the three Evidence MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 *
 * Evidence is a polymorphic entity that attaches to exactly one OST node:
 * an Opportunity, a Solution, or an Assumption. Aurora DSQL has no CHECK
 * constraints, so the "exactly one of opportunityId/solutionId/assumptionId"
 * invariant is enforced here in application code.
 */

import getPrisma from "@/lib/db"
import type { EvidenceSourceType, EvidenceConfidence } from "@/lib/types"

type NodeTarget = {
  opportunityId?: string
  solutionId?: string
  assumptionId?: string
}

function countTargets({ opportunityId, solutionId, assumptionId }: NodeTarget) {
  return [opportunityId, solutionId, assumptionId].filter(Boolean).length
}

async function findTargetNode(
  prisma: ReturnType<typeof getPrisma>,
  { opportunityId, solutionId, assumptionId }: NodeTarget
) {
  if (opportunityId) {
    return {
      kind: "opportunity" as const,
      id: opportunityId,
      node: await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { id: true, title: true } }),
    }
  }
  if (solutionId) {
    return {
      kind: "solution" as const,
      id: solutionId,
      node: await prisma.solution.findUnique({ where: { id: solutionId }, select: { id: true, title: true } }),
    }
  }
  return {
    kind: "assumption" as const,
    id: assumptionId!,
    node: await prisma.assumption.findUnique({ where: { id: assumptionId }, select: { id: true, title: true } }),
  }
}

export async function addEvidence({
  workspaceId,
  sourceType,
  excerpt,
  confidence,
  sourceUrl,
  opportunityId,
  solutionId,
  assumptionId,
}: {
  workspaceId: string
  sourceType: EvidenceSourceType
  excerpt: string
  confidence?: EvidenceConfidence
  sourceUrl?: string
  opportunityId?: string
  solutionId?: string
  assumptionId?: string
}) {
  const target: NodeTarget = { opportunityId, solutionId, assumptionId }
  const targetCount = countTargets(target)
  if (targetCount !== 1) {
    return {
      content: [{
        type: "text" as const,
        text: `Exactly one of opportunityId, solutionId, or assumptionId must be provided (got ${targetCount}).`,
      }],
    }
  }

  const prisma = getPrisma()
  const { kind, id, node } = await findTargetNode(prisma, target)
  if (!node) {
    return { content: [{ type: "text" as const, text: `${kind} "${id}" not found.` }] }
  }

  const created = await prisma.evidence.create({
    data: {
      workspaceId,
      sourceType,
      excerpt,
      confidence: confidence ?? "medium",
      sourceUrl,
      opportunityId,
      solutionId,
      assumptionId,
    },
  })

  return {
    content: [{
      type: "text" as const,
      text: `Created evidence (ID: ${created.id}) linked to ${kind} '${node.title}'.`,
    }],
  }
}

export async function linkEvidence({
  evidenceId,
  opportunityId,
  solutionId,
  assumptionId,
}: {
  evidenceId: string
  opportunityId?: string
  solutionId?: string
  assumptionId?: string
}) {
  const target: NodeTarget = { opportunityId, solutionId, assumptionId }
  const targetCount = countTargets(target)
  if (targetCount !== 1) {
    return {
      content: [{
        type: "text" as const,
        text: `Exactly one of opportunityId, solutionId, or assumptionId must be provided (got ${targetCount}).`,
      }],
    }
  }

  const prisma = getPrisma()
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, excerpt: true, workspaceId: true },
  })
  if (!evidence) {
    return { content: [{ type: "text" as const, text: `Evidence "${evidenceId}" not found.` }] }
  }

  const { kind, id, node } = await findTargetNode(prisma, target)
  if (!node) {
    return { content: [{ type: "text" as const, text: `${kind} "${id}" not found.` }] }
  }

  await prisma.evidence.update({
    where: { id: evidenceId },
    data: {
      opportunityId: opportunityId ?? null,
      solutionId: solutionId ?? null,
      assumptionId: assumptionId ?? null,
      updatedAt: new Date(),
    },
  })

  return {
    content: [{
      type: "text" as const,
      text: `Linked evidence '${evidence.excerpt.slice(0, 60)}${evidence.excerpt.length > 60 ? "…" : ""}' to ${kind} '${node.title}'.`,
    }],
  }
}

export async function listEvidence({
  nodeId,
  nodeType,
}: {
  nodeId: string
  nodeType: "opportunity" | "solution" | "assumption"
}) {
  const prisma = getPrisma()
  const where =
    nodeType === "opportunity"
      ? { opportunityId: nodeId }
      : nodeType === "solution"
        ? { solutionId: nodeId }
        : { assumptionId: nodeId }

  const items = await prisma.evidence.findMany({
    where,
    orderBy: { createdAt: "desc" },
  })

  if (!items.length) {
    return { content: [{ type: "text" as const, text: "No evidence found." }] }
  }

  const lines = items.map(e =>
    `• **${e.sourceType}** [${e.confidence} confidence]\n` +
    `  ID: ${e.id}\n` +
    `  ${e.excerpt.slice(0, 150)}${e.excerpt.length > 150 ? "…" : ""}\n` +
    (e.sourceUrl ? `  Source: ${e.sourceUrl}\n` : "") +
    `  Created: ${e.createdAt.toISOString()}`
  )

  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] }
}
