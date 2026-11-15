export const DECISION_UPDATED_EVENT = "compass:decision-updated"

export type DecisionBadgeTone = "neutral" | "info" | "success" | "warning" | "danger"

export function notifyDecisionUpdated(revisionId: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DECISION_UPDATED_EVENT, { detail: { revisionId } }))
  }
}

export function decisionStatusBadgeProps(input: {
  state: string
  outcomeClass?: string | null
  outcomeLabel?: string | null
  stale?: boolean
  readOnlyLegacy?: boolean
}): { status: DecisionBadgeTone; label: string } {
  if (input.readOnlyLegacy && !input.outcomeClass) {
    return { status: "neutral", label: "Read-only" }
  }
  if (input.stale && !input.outcomeClass) {
    return { status: "warning", label: "Stale" }
  }
  if (input.outcomeClass) {
    switch (input.outcomeClass) {
      case "APPROVE":
        return { status: "success", label: "Approved" }
      case "REQUEST_CHANGES":
        return { status: "warning", label: "Changes requested" }
      case "REJECT":
        return { status: "danger", label: "Rejected" }
      default:
        return { status: "neutral", label: input.outcomeLabel || "Decided" }
    }
  }
  if (input.state === "PENDING") {
    return { status: "neutral", label: "Awaiting review" }
  }
  return { status: "neutral", label: input.state.toLowerCase() }
}

export function plainTextPreview(markdown: string | null | undefined, maxChars = 180): string | null {
  if (!markdown) return null
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|-|\*|\+|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!stripped) return null
  if (stripped.length <= maxChars) return stripped
  return `${stripped.slice(0, maxChars - 1).trimEnd()}…`
}
