/**
 * Plain-language rendering for inbox rows. Notifications store machine facts
 * only (kind, from, to), so the sentence is built here at read time. Kept free
 * of React and I/O so the same wording backs the inbox and its tests.
 */
const SUBJECT_LABELS: Record<string, string> = {
  OPPORTUNITY: "Opportunity",
  SOLUTION: "Solution",
  TASK: "Task",
  DOC: "Doc",
  ASSUMPTION: "Assumption",
  EXPERIMENT: "Experiment",
  ROADMAP_ITEM: "Roadmap item",
  OBJECTIVE: "Objective",
  KEY_RESULT: "Key result",
  FEEDBACK_ITEM: "Feedback",
  REVIEW_REQUEST: "Decision",
  RESEARCH_STUDY: "Research study",
  ARTIFACT: "Artifact",
  METRIC: "Metric",
}

export const subjectTypeLabel = (type: string): string => SUBJECT_LABELS[type] ?? "Item"

/** `IN_PROGRESS` -> `In progress`. */
export function humanizeValue(value: string | undefined | null): string {
  if (!value) return ""
  const spaced = value.replace(/_/g, " ").toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export type NotificationSentenceInput = {
  kind: string
  actorName: string
  payload: Record<string, string>
}

/** The action only, e.g. "changed status from Todo to Done". The caller renders the actor separately. */
export function notificationAction({ kind, payload }: Pick<NotificationSentenceInput, "kind" | "payload">): string {
  switch (kind) {
    case "STATUS_CHANGED": {
      const to = humanizeValue(payload.to)
      const from = humanizeValue(payload.from)
      if (!to) return "changed the status"
      return from ? `changed status from ${from} to ${to}` : `set status to ${to}`
    }
    case "COMMENT_ADDED":
      return "commented"
    case "COMMENT_REPLIED":
      return "replied to a comment"
    case "ASSIGNED":
      return "assigned this to you"
    default:
      return "made a change"
  }
}

export const notificationSentence = (input: NotificationSentenceInput): string => `${input.actorName} ${notificationAction(input)}`

/** Compact bell label: capped at 99+. */
export function formatUnread(count: number, overflow: boolean): string {
  return overflow || count > 99 ? "99+" : String(count)
}
