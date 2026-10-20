/**
 * Pure client-state transitions for the editable Product Spec Canvas.
 *
 * The canvas is still a lens: this state is only a local mirror of rows that the
 * existing mutation paths persist. The reducer applies an edit optimistically,
 * keeps every derived field (tones, counts, parent titles on children) in step,
 * and never re-sorts on a plain edit, so a card does not jump while it is being
 * changed. Order is decided by the loader on the next page load.
 */
import {
  assumptionStatusTone,
  experimentStatusTone,
  opportunityStatusTone,
  riskTone,
  solutionStatusTone,
  type SpecAssumption,
  type SpecCanvas,
  type SpecExperiment,
  type SpecSolution,
} from "./shape"

export type EditableField = "title" | "description" | "status" | "riskLevel" | "hypothesis"
export type EditableEntity = "opportunity" | "solution" | "assumption" | "experiment"

export type SpecAction =
  | { type: "patch"; entity: EditableEntity; id: string; field: EditableField; value: string | null }
  | { type: "addSolution"; solution: SpecSolution }
  | { type: "addAssumption"; assumption: SpecAssumption }
  | { type: "addExperiment"; experiment: SpecExperiment }

/** The value a field holds now, so a failed save can restore it. Undefined when the entity or field does not exist. */
export function currentValue(state: SpecCanvas, entity: EditableEntity, id: string, field: EditableField): string | null | undefined {
  switch (entity) {
    case "opportunity":
      if (state.opportunity.id !== id) return undefined
      return field === "title" ? state.opportunity.title : field === "description" ? state.opportunity.description : field === "status" ? state.opportunity.status : undefined
    case "solution": {
      const row = state.solutions.find((s) => s.id === id)
      return row && (field === "title" ? row.title : field === "description" ? row.description : field === "status" ? row.status : undefined)
    }
    case "assumption": {
      const row = state.assumptions.find((a) => a.id === id)
      return row && (field === "title" ? row.title : field === "description" ? row.description : field === "status" ? row.status : field === "riskLevel" ? row.riskLevel : undefined)
    }
    case "experiment": {
      const row = state.experiments.find((e) => e.id === id)
      return row && (field === "title" ? row.title : field === "hypothesis" ? row.hypothesis : field === "status" ? row.status : undefined)
    }
  }
}

const recount = (state: SpecCanvas): SpecCanvas => ({
  ...state,
  solutions: state.solutions.map((solution) => ({
    ...solution,
    assumptionCount: state.assumptions.filter((a) => a.solutionId === solution.id).length,
  })),
  assumptions: state.assumptions.map((assumption) => ({
    ...assumption,
    experimentCount: state.experiments.filter((e) => e.assumptionId === assumption.id).length,
  })),
})

/** Insert after the last sibling sharing `parentKey`, so a new child lands under its parent; at the end when it has none yet. */
function insertAfterSiblings<T>(list: readonly T[], item: T, sameParent: (existing: T) => boolean): T[] {
  let last = -1
  list.forEach((existing, index) => { if (sameParent(existing)) last = index })
  if (last === -1) return [...list, item]
  return [...list.slice(0, last + 1), item, ...list.slice(last + 1)]
}

export function specReducer(state: SpecCanvas, action: SpecAction): SpecCanvas {
  switch (action.type) {
    case "patch": {
      return applyPatch(state, action)
    }
    case "addSolution":
      if (state.solutions.some((s) => s.id === action.solution.id)) return state
      return { ...state, solutions: [...state.solutions, action.solution] }
    case "addAssumption":
      if (state.assumptions.some((a) => a.id === action.assumption.id)) return state
      return recount({
        ...state,
        assumptions: insertAfterSiblings(state.assumptions, action.assumption, (a) => a.solutionId === action.assumption.solutionId),
      })
    case "addExperiment":
      if (state.experiments.some((e) => e.id === action.experiment.id)) return state
      return recount({
        ...state,
        experiments: insertAfterSiblings(state.experiments, action.experiment, (e) => e.assumptionId === action.experiment.assumptionId),
      })
  }
}

function applyPatch(state: SpecCanvas, action: Extract<SpecAction, { type: "patch" }>): SpecCanvas {
  {
    {
      const { entity, id, field, value } = action
      switch (entity) {
        case "opportunity": {
          if (state.opportunity.id !== id) return state
          if (field === "title" && value !== null) return { ...state, opportunity: { ...state.opportunity, title: value } }
          if (field === "description") return { ...state, opportunity: { ...state.opportunity, description: value } }
          if (field === "status" && value !== null) return { ...state, opportunity: { ...state.opportunity, status: value, statusTone: opportunityStatusTone(value) } }
          return state
        }
        case "solution": {
          const target = state.solutions.find((s) => s.id === id)
          if (!target) return state
          if (field === "title" && value !== null) {
            const previous = target.title
            return {
              ...state,
              solutions: state.solutions.map((s) => (s.id === id ? { ...s, title: value } : s)),
              assumptions: state.assumptions.map((a) => (a.solutionId === id ? { ...a, solutionTitle: value } : a)),
              artifacts: state.artifacts.map((art) => ({ ...art, solutionTitles: art.solutionTitles.map((t) => (t === previous ? value : t)) })),
            }
          }
          if (field === "description") return { ...state, solutions: state.solutions.map((s) => (s.id === id ? { ...s, description: value } : s)) }
          if (field === "status" && value !== null) return { ...state, solutions: state.solutions.map((s) => (s.id === id ? { ...s, status: value, statusTone: solutionStatusTone(value) } : s)) }
          return state
        }
        case "assumption": {
          const target = state.assumptions.find((a) => a.id === id)
          if (!target) return state
          const update = (patch: Partial<SpecAssumption>): SpecCanvas => ({ ...state, assumptions: state.assumptions.map((a) => (a.id === id ? { ...a, ...patch } : a)) })
          if (field === "title" && value !== null) {
            return { ...update({ title: value }), experiments: state.experiments.map((e) => (e.assumptionId === id ? { ...e, assumptionTitle: value } : e)) }
          }
          if (field === "description") return update({ description: value })
          if (field === "status" && value !== null) return update({ status: value, statusTone: assumptionStatusTone(value) })
          if (field === "riskLevel" && value !== null) return update({ riskLevel: value, riskTone: riskTone(value) })
          return state
        }
        case "experiment": {
          const target = state.experiments.find((e) => e.id === id)
          if (!target) return state
          const update = (patch: Partial<SpecExperiment>): SpecCanvas => ({ ...state, experiments: state.experiments.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
          if (field === "title" && value !== null) return update({ title: value })
          if (field === "hypothesis" && value !== null) return update({ hypothesis: value })
          if (field === "status" && value !== null) return update({ status: value, statusTone: experimentStatusTone(value) })
          return state
        }
      }
    }
  }
  return state
}
