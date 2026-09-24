/**
 * Handler functions for the three Evidence MCP tools.
 * Extracted into this module so they can be unit-tested without the MCP server layer.
 *
 * Evidence is a polymorphic entity that attaches to exactly one OST node:
 * an Opportunity, a Solution, or an Assumption. Aurora DSQL has no CHECK
 * constraints, so the "exactly one of opportunityId/solutionId/assumptionId"
 * invariant is enforced here in application code.
 */

import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"
import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { loadEvidenceProvenance, type EvidenceProvenance } from "@/lib/evidence-provenance"
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
    return fail(`Exactly one of opportunityId, solutionId, or assumptionId must be provided (got ${targetCount}).`)
  }

  const prisma = getPrisma()
  const { kind, id, node } = await findTargetNode(prisma, target)
  if (!node) {
    return fail(`${kind} "${id}" not found.`)
  }

  const created = await captureWorkspaceMutation(prisma, "evidence", "create", "MCP", undefined, tx => tx.evidence.create({
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
  }))

  return ok(`Created evidence (ID: ${created.id}) linked to ${kind} '${node.title}'.`, created)
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
    return fail(`Exactly one of opportunityId, solutionId, or assumptionId must be provided (got ${targetCount}).`)
  }

  const prisma = getPrisma()
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: { id: true, excerpt: true, workspaceId: true },
  })
  if (!evidence) {
    return fail(`Evidence "${evidenceId}" not found.`)
  }

  const { kind, id, node } = await findTargetNode(prisma, target)
  if (!node) {
    return fail(`${kind} "${id}" not found.`)
  }

  await captureWorkspaceMutation(prisma, "evidence", "update", "MCP", evidenceId, tx => tx.evidence.update({
    where: { id: evidenceId },
    data: {
      opportunityId: opportunityId ?? null,
      solutionId: solutionId ?? null,
      assumptionId: assumptionId ?? null,
      updatedAt: new Date(),
    },
  }))

  return ok(
    `Linked evidence '${evidence.excerpt.slice(0, 60)}${evidence.excerpt.length > 60 ? "…" : ""}' to ${kind} '${node.title}'.`,
    {
      id: evidence.id,
      opportunityId: opportunityId ?? null,
      solutionId: solutionId ?? null,
      assumptionId: assumptionId ?? null,
    }
  )
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
    return fail("No evidence found.")
  }

  // ADR-0012 step 6a. Costs nothing when nothing on this node was promoted;
  // see lib/evidence-provenance.ts for why turn text is referenced, not inlined.
  const provenance = await loadEvidenceProvenance(items)

  const lines = items.map(e =>
    `• **${e.sourceType}** [${e.confidence} confidence]\n` +
    `  ID: ${e.id}\n` +
    `  ${e.excerpt.slice(0, 150)}${e.excerpt.length > 150 ? "…" : ""}\n` +
    (e.sourceUrl ? `  Source: ${e.sourceUrl}\n` : "") +
    provenanceLines(provenance.get(e.id)) +
    `  Created: ${e.createdAt.toISOString()}`
  )

  // An explicit allowlist, not a row spread — and `research` is added only for
  // rows that have it, so a non-promoted row's projection is byte-identical to
  // the pre-052 shape every existing caller already parses.
  const projected = items.map(e => {
    const research = provenance.get(e.id)
    return {
      id: e.id,
      sourceType: e.sourceType,
      excerpt: e.excerpt,
      confidence: e.confidence,
      sourceUrl: e.sourceUrl,
      parent: { type: nodeType, id: nodeId },
      ...(research ? { research } : {}),
    }
  })

  const message = provenance.size
    ? `${lines.join("\n\n")}\n\nSource turn text is not included here — call get_research_session with the study and session above to read the saved transcript.`
    : lines.join("\n\n")

  return ok(message, { items: projected, count: items.length })
}

/** The provenance block inside one evidence row's text rendering; empty for
 * every row that was not promoted from a research synthesis. */
function provenanceLines(research: EvidenceProvenance | undefined) {
  if (!research) return ""
  const cited = research.sources.map(source =>
    source.resolved
      ? `    - turn ${source.researchTurnId} (study ${source.studyId}, session ${source.sessionId}, #${source.sequence}, ${source.role})`
      : `    - turn ${source.researchTurnId} — no longer saved`
  )
  return `  Research synthesis: ${research.researchSynthesisId}\n` +
    `  Cites ${research.sources.length} saved turn${research.sources.length === 1 ? "" : "s"}:\n` +
    (cited.length ? `${cited.join("\n")}\n` : "")
}
