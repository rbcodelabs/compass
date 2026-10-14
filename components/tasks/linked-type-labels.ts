import type { ResolvedLabels } from "@/lib/thinking-model/labels"
import type { TaskLinkedType } from "@/lib/types"

/**
 * Display names for the things a task can link to. The four product entities
 * come from the workspace's thinking model; the rest are not entities a model
 * renames. Case matches today's copy exactly (title case for the singular form,
 * sentence case for the plural form used by the filter chips).
 */
export function linkedTypeLabels(labels: ResolvedLabels): Record<TaskLinkedType, string> {
  return {
    OPPORTUNITY: labels.opportunity.singular,
    SOLUTION: labels.solution.singular,
    ROADMAP_ITEM: "Roadmap Item",
    OBJECTIVE: labels.objective.singular,
    KEY_RESULT: labels.keyResult.singular,
    DOC: "Doc",
    EXPERIMENT: "Experiment",
    FEEDBACK_ITEM: "Feedback Item",
    DECISION: "Decision",
  }
}

export function linkedTypePluralLabels(labels: ResolvedLabels): Record<TaskLinkedType, string> {
  return {
    OPPORTUNITY: labels.opportunity.plural,
    SOLUTION: labels.solution.plural,
    ROADMAP_ITEM: "Roadmap items",
    OBJECTIVE: labels.objective.plural,
    KEY_RESULT: labels.keyResult.sentencePlural,
    DOC: "Docs",
    EXPERIMENT: "Experiments",
    FEEDBACK_ITEM: "Feedback items",
    DECISION: "Decisions",
  }
}
