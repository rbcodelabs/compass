/**
 * Pure "did a tracked field actually change" detection, split out of
 * lib/workspace-update-mutations.ts so it can be reused without the Workspace
 * Updates machinery (ADR "Following and in-app notifications", open question 8).
 *
 * It has no I/O and no dependency on WORKSPACE_UPDATES_ENABLED. The adapter still
 * owns reading the before-state, resolving the actor and workspace, and deciding
 * whether to run at all; this only compares two rows.
 */
export type TransitionRow = { status?: string; horizon?: string }

export type FieldTransition = {
  field: "status" | "horizon"
  /** `undefined` when there was no before row (a create) or it lacked the field. */
  from: string | null | undefined
  to: string
}

/** Roadmap items also report horizon moves to the Updates feed; every other model is status only. */
const fieldsFor = (model: string) => (model === "roadmapItem" ? (["status", "horizon"] as const) : (["status"] as const))

export function detectFieldTransitions(model: string, before: TransitionRow | null, after: TransitionRow): FieldTransition[] {
  return fieldsFor(model).flatMap((field) => {
    const to = after[field]
    // A mutation result that does not carry the field says nothing about it.
    if (to === undefined || before?.[field] === to) return []
    return [{ field, from: before?.[field], to }]
  })
}
