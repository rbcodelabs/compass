import type { ResolvedLabels } from "@/lib/thinking-model/labels"
import type { CustomFieldObjectType } from "@/lib/types"

/** Order the object types appear in on the settings screens. */
export const OBJECT_TYPES: CustomFieldObjectType[] = [
  "OPPORTUNITY",
  "SOLUTION",
  "EXPERIMENT",
  "OBJECTIVE",
  "KEY_RESULT",
  "ROADMAP_ITEM",
  "TASK",
]

/** Display names for the objects a custom field can attach to. */
export function objectTypeLabels(labels: ResolvedLabels): Record<CustomFieldObjectType, string> {
  return {
    OPPORTUNITY: labels.opportunity.singular,
    SOLUTION: labels.solution.singular,
    EXPERIMENT: "Experiment",
    OBJECTIVE: labels.objective.singular,
    KEY_RESULT: labels.keyResult.singular,
    ROADMAP_ITEM: "Roadmap Item",
    TASK: "Task",
  }
}
