import { Prisma } from "@prisma/client"
import { MODEL_BUCKETS } from "@/lib/workspace-export/model-registry"

/**
 * How to find the rows of a workspace for each exported model.
 *
 *  - A model with a `workspaceId` column is selected by it.
 *  - Every other exported model lists its parent here: rows are selected by
 *    `fk IN (parent ids already exported)`.
 *  - `Workspace` (by `id`) and workspace-owned `Agent` are special cases.
 *
 * `relationMode = "prisma"` means no database foreign keys, so the parent chain
 * is declared by hand. A test asserts every exported model is reachable.
 */
export const PARENT: Readonly<Record<string, { model: string; fk: string }>> = {
  ResearchSession: { model: "ResearchStudy", fk: "studyId" },
  ResearchTurn: { model: "ResearchSession", fk: "sessionId" },
  ResearchSynthesis: { model: "ResearchStudy", fk: "studyId" },
  CheckIn: { model: "KeyResult", fk: "keyResultId" },
  SolutionComment: { model: "Solution", fk: "solutionId" },
  DocCommentAnchor: { model: "Comment", fk: "commentId" },
  SolutionPlanProposal: { model: "Comment", fk: "commentId" },
  CommentElementAnchor: { model: "Comment", fk: "commentId" },
  CommentExternalAuthor: { model: "Comment", fk: "commentId" },
  OpportunityScore: { model: "Opportunity", fk: "opportunityId" },
  SolutionScore: { model: "Solution", fk: "solutionId" },
  ExperimentResult: { model: "Experiment", fk: "experimentId" },
  ReviewRevision: { model: "ReviewRequest", fk: "requestId" },
  DecisionEvidenceRef: { model: "ReviewRevision", fk: "reviewRevisionId" },
  ReviewOption: { model: "ReviewRevision", fk: "revisionId" },
  DecisionApplication: { model: "DecisionRecord", fk: "decisionId" },
  ChecklistTemplateItem: { model: "ChecklistTemplate", fk: "checklistTemplateId" },
  LaunchChecklist: { model: "RoadmapItem", fk: "roadmapItemId" },
  LaunchChecklistItem: { model: "LaunchChecklist", fk: "launchChecklistId" },
  CustomFieldValue: { model: "CustomFieldDefinition", fk: "fieldId" },
  CardSortProposal: { model: "CardSortRound", fk: "roundId" },
  CardSortNewEntry: { model: "CardSortRound", fk: "roundId" },
  FeedbackElementAnchor: { model: "FeedbackItem", fk: "feedbackItemId" },
  FeedbackAttachment: { model: "FeedbackItem", fk: "feedbackItemId" },
  FeedbackVote: { model: "FeedbackItem", fk: "feedbackId" },
  DocComment: { model: "Doc", fk: "docId" },
  DocVersion: { model: "Doc", fk: "docId" },
  ArtifactRevision: { model: "Artifact", fk: "artifactId" },
  EvidenceResearchSource: { model: "Evidence", fk: "evidenceId" },
  RoadmapVote: { model: "RoadmapItem", fk: "roadmapItemId" },
  CapabilityPackVersion: { model: "CapabilityPack", fk: "capabilityPackId" },
}

/** Exported models in parent-before-child order, `Workspace` excluded (handled separately). */
export function exportOrder(): string[] {
  const models = Object.entries(MODEL_BUCKETS)
    .filter(([name, bucket]) => bucket === "CONTENT" && name !== "Workspace")
    .map(([name]) => name)
  const depth = (name: string, seen = new Set<string>()): number => {
    const parent = PARENT[name]
    if (!parent || seen.has(name)) return 0
    seen.add(name)
    return 1 + depth(parent.model, seen)
  }
  return models.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

export const dmmfModels = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]))

export function modelHasWorkspaceId(model: string): boolean {
  return dmmfModels.get(model)?.fields.some((f) => f.name === "workspaceId") ?? false
}

export function modelHasId(model: string): boolean {
  return dmmfModels.get(model)?.fields.some((f) => f.name === "id") ?? false
}

/** Prisma client delegate key: lower-case the first character only (`OKRCycle` -> `oKRCycle`). */
export function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1)
}

export type Delegate = {
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>
  createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<{ count: number }>
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>
  count(args: { where: Record<string, unknown> }): Promise<number>
}

export function delegateFor(client: unknown, model: string): Delegate {
  const d = (client as Record<string, unknown>)[delegateKey(model)]
  if (!d) throw new Error(`No Prisma delegate for model ${model}`)
  return d as Delegate
}
