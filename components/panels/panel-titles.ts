import type { ResolvedLabels } from "@/lib/thinking-model/labels"

/** Detail-panel titles by panel type. A function because the entity titles come from the workspace's thinking model. */
export const panelTitles = (labels: ResolvedLabels): Record<string, string> => ({
  objective: labels.objective.singular,
  keyResult: labels.keyResult.singular,
  opportunity: labels.opportunity.singular,
  solution: labels.solution.singular,
  assumption: "Assumption",
  experiment: "Experiment",
  roadmapItem: "Roadmap Item",
  feedback: "Feedback",
  "feedback-new": "New feedback",
  "opportunity-new": `New ${labels.opportunity.lower}`,
  task: "Task",
  "discovery-rail": "Discovery",
})
