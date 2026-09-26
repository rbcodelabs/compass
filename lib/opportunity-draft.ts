/**
 * In-progress "New opportunity" drafts, persisted to localStorage per
 * workspace. Storage, keying and tolerant parsing are shared with every
 * composer — see lib/composer-draft.ts.
 *
 * Linked ids (squad, key result, feedback) are stored as chosen. The composer
 * drops any that no longer exist when its options load, and the server
 * re-validates every one on submit, so a stale id can never be written.
 */
import { createComposerDraftStore, draftId, draftString } from "@/lib/composer-draft"
import type { OpportunityStatus } from "@/lib/types"

// Limits shared by the composer and the server (lib/opportunity-create.ts).
// Title and segment mirror their `@db.VarChar(255)` columns.
export const OPPORTUNITY_TITLE_MAX_LENGTH = 255
export const OPPORTUNITY_SEGMENT_MAX_LENGTH = 255
/** A seed set, not a bulk re-parenting tool; keeps one transaction small. */
export const OPPORTUNITY_SEED_FEEDBACK_MAX = 50

/** The statuses a new opportunity can start in (never ARCHIVED). */
export const NEW_OPPORTUNITY_STATUSES = ["EXPLORING", "VALIDATING", "PRIORITIZED", "ACTIVE"] as const

export type NewOpportunityStatus = (typeof NEW_OPPORTUNITY_STATUSES)[number]

export function isNewOpportunityStatus(value: unknown): value is NewOpportunityStatus {
  return typeof value === "string" && (NEW_OPPORTUNITY_STATUSES as readonly string[]).includes(value)
}

export type OpportunityDraft = {
  title: string
  description: string
  customerSegment: string
  status: NewOpportunityStatus
  squadId: string | null
  keyResultId: string | null
  feedbackIds: string[]
}

export const EMPTY_OPPORTUNITY_DRAFT: OpportunityDraft = Object.freeze({
  title: "",
  description: "",
  customerSegment: "",
  status: "EXPLORING",
  squadId: null,
  keyResultId: null,
  feedbackIds: [],
}) as OpportunityDraft

/**
 * Status alone is not content: it is usually preset by the column the
 * composer was opened from. Anything the user typed or picked is.
 */
export function isOpportunityDraftEmpty(draft: OpportunityDraft): boolean {
  return (
    !draft.title.trim() &&
    !draft.description.trim() &&
    !draft.customerSegment.trim() &&
    !draft.squadId &&
    !draft.keyResultId &&
    draft.feedbackIds.length === 0
  )
}

const store = createComposerDraftStore<OpportunityDraft>({
  kind: "opportunity",
  version: 1,
  isEmpty: isOpportunityDraftEmpty,
  fromRecord: (v) => ({
    title: draftString(v.title),
    description: draftString(v.description),
    customerSegment: draftString(v.customerSegment),
    status: isNewOpportunityStatus(v.status) ? v.status : "EXPLORING",
    squadId: draftId(v.squadId),
    keyResultId: draftId(v.keyResultId),
    feedbackIds: Array.isArray(v.feedbackIds)
      ? [...new Set(v.feedbackIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [],
  }),
})

export const opportunityDraftKey = store.key
export const parseOpportunityDraft = store.parse
export const serializeOpportunityDraft = store.serialize
export const loadOpportunityDraft = store.load
export const saveOpportunityDraft = store.save
export const clearOpportunityDraft = store.clear

/**
 * The composer's panel id. A plain `new` opens it with the draft's (or the
 * default) status; `new-<status>` — what a board column's "Add opportunity"
 * opens — presets that column's status. Keeps the `?detail=<kind>-new:new`
 * shape while letting the URL carry the one bit of context a column adds.
 */
export const OPPORTUNITY_COMPOSER_ID = "new"

export function opportunityComposerId(status?: OpportunityStatus | null): string {
  return status && isNewOpportunityStatus(status)
    ? `${OPPORTUNITY_COMPOSER_ID}-${status.toLowerCase()}`
    : OPPORTUNITY_COMPOSER_ID
}

export function presetStatusFromComposerId(id: string): NewOpportunityStatus | null {
  const prefix = `${OPPORTUNITY_COMPOSER_ID}-`
  if (!id.startsWith(prefix)) return null
  const status = id.slice(prefix.length).toUpperCase()
  return isNewOpportunityStatus(status) ? status : null
}
