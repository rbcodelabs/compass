/**
 * Client-side mutation wrappers for the editable Product Spec Canvas.
 *
 * No new writes live here. Every wrapper validates its input, then calls an
 * existing, already-authorized path:
 *   - field edits  -> PATCH /api/panels/entity/{type}/{id} (updateEntityField,
 *                     membership + workspace scoped, read-only workspaces refused)
 *   - new solution -> addSolution            (workspace derived from the parent opportunity)
 *   - new assumption -> addAssumption        (workspace derived from the parent solution)
 *   - new experiment -> createExperiment     (assumption verified inside the workspace)
 * so the scoping rules stay in one place. The wrappers only shape results back
 * into canvas rows.
 */
import { addAssumption, addSolution } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions"
import { createExperiment } from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions"
import { patchEntityField } from "@/components/panels/panel-parts"
import { buildSpecAssumption, buildSpecExperiment, buildSpecSolution, type SpecAssumption, type SpecExperiment, type SpecSolution } from "./shape"
import type { EditableEntity, EditableField } from "./reducer"

export type SpecContext = { orgSlug: string; workspaceSlug: string; workspaceId: string; opportunityId: string }

/** Mirrors TITLE_MAX_LENGTH in lib/entity-mutations.ts (server-only module, so not importable here). */
const TITLE_MAX_LENGTH = 255

export class SpecValidationError extends Error {}

/** Trimmed title, or a `SpecValidationError` the UI shows next to the input. */
export function normalizeTitle(raw: string): string {
  const title = raw.trim()
  if (!title) throw new SpecValidationError("Add a title first.")
  if (title.length > TITLE_MAX_LENGTH) throw new SpecValidationError(`Titles must be ${TITLE_MAX_LENGTH} characters or fewer.`)
  return title
}

const FIELDS: Record<EditableEntity, readonly EditableField[]> = {
  opportunity: ["title", "description", "status"],
  solution: ["title", "description", "status"],
  assumption: ["title", "description", "status", "riskLevel"],
  experiment: ["title", "hypothesis", "status"],
}

/** Persist one field. Titles and the experiment hypothesis are required; descriptions may be cleared. */
export async function saveSpecField(ctx: Pick<SpecContext, "orgSlug" | "workspaceSlug">, entity: EditableEntity, id: string, field: EditableField, value: string | null): Promise<void> {
  if (!FIELDS[entity].includes(field)) throw new SpecValidationError(`${field} cannot be edited on this card.`)
  const next = field === "title" ? normalizeTitle(value ?? "") : field === "hypothesis" ? (value ?? "").trim() : value
  if (field === "hypothesis" && !next) throw new SpecValidationError("The hypothesis cannot be empty.")
  await patchEntityField(entity, id, ctx.orgSlug, ctx.workspaceSlug, field, next)
}

const detailPath = (ctx: SpecContext) => `/${ctx.orgSlug}/${ctx.workspaceSlug}/discovery/${ctx.opportunityId}`
const slugs = (ctx: SpecContext) => ({ orgSlug: ctx.orgSlug, workspaceSlug: ctx.workspaceSlug })

export async function createSpecSolution(ctx: SpecContext, rawTitle: string): Promise<SpecSolution> {
  const title = normalizeTitle(rawTitle)
  const row = await addSolution(ctx.opportunityId, { title }, detailPath(ctx))
  return buildSpecSolution(row, slugs(ctx), ctx.opportunityId)
}

export async function createSpecAssumption(ctx: SpecContext, solution: { id: string; title: string }, rawTitle: string, riskLevel: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM"): Promise<SpecAssumption> {
  const title = normalizeTitle(rawTitle)
  const row = await addAssumption(solution.id, { title, riskLevel }, detailPath(ctx))
  return buildSpecAssumption(row, solution, slugs(ctx), ctx.opportunityId)
}

/**
 * The experiment model requires a hypothesis, method and kill condition, but a
 * keyboard-first insert only has a title. The hypothesis starts as the title (it
 * is editable in place straight away); method and kill condition get an explicit
 * "not defined yet" marker that the experiment's own page lets the team replace.
 */
export const EXPERIMENT_PLACEHOLDER = "Not defined yet"

export async function createSpecExperiment(ctx: SpecContext, assumption: { id: string; title: string }, rawTitle: string): Promise<SpecExperiment> {
  const title = normalizeTitle(rawTitle)
  const row = await createExperiment(ctx.workspaceId, {
    title,
    hypothesis: title,
    method: EXPERIMENT_PLACEHOLDER,
    killCondition: EXPERIMENT_PLACEHOLDER,
    assumptionId: assumption.id,
  })
  return buildSpecExperiment(row, assumption, slugs(ctx))
}
