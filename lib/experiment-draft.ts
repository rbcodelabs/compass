/**
 * In-progress "New experiment" drafts, persisted to localStorage per
 * workspace. Storage, keying and tolerant parsing are shared with every
 * composer — see lib/composer-draft.ts.
 *
 * Linked ids (squad, assumption, metrics) are stored as chosen. The composer drops any
 * that no longer exist when its options load, and the server re-validates
 * every one on submit, so a stale id can never be written.
 */
import { createComposerDraftStore, draftId, draftString } from "@/lib/composer-draft"

// Title mirrors its `@db.VarChar(255)` column.
export const EXPERIMENT_TITLE_MAX_LENGTH = 255

export type ExperimentDraft = {
  title: string
  hypothesis: string
  method: string
  killCondition: string
  squadId: string | null
  assumptionId: string | null
  /** Workspace metrics to track on the experiment once it exists. */
  metricIds: string[]
}

export const EMPTY_EXPERIMENT_DRAFT: ExperimentDraft = Object.freeze({
  title: "",
  hypothesis: "",
  method: "",
  killCondition: "",
  squadId: null,
  assumptionId: null,
  metricIds: [],
}) as ExperimentDraft

/**
 * The tested assumption is usually preset by the "Test this assumption" link
 * that opened the composer, so on its own it is context, not content.
 * Anything the user typed or picked otherwise is.
 */
export function isExperimentDraftEmpty(draft: ExperimentDraft): boolean {
  return (
    !draft.title.trim() &&
    !draft.hypothesis.trim() &&
    !draft.method.trim() &&
    !draft.killCondition.trim() &&
    !draft.squadId &&
    draft.metricIds.length === 0
  )
}

const store = createComposerDraftStore<ExperimentDraft>({
  kind: "experiment",
  version: 1,
  isEmpty: isExperimentDraftEmpty,
  fromRecord: (v) => ({
    title: draftString(v.title),
    hypothesis: draftString(v.hypothesis),
    method: draftString(v.method),
    killCondition: draftString(v.killCondition),
    squadId: draftId(v.squadId),
    assumptionId: draftId(v.assumptionId),
    metricIds: Array.isArray(v.metricIds)
      ? [...new Set(v.metricIds.map(draftId).filter((id): id is string => !!id))]
      : [],
  }),
})

export const experimentDraftKey = store.key
export const parseExperimentDraft = store.parse
export const serializeExperimentDraft = store.serialize
export const loadExperimentDraft = store.load
export const saveExperimentDraft = store.save
export const clearExperimentDraft = store.clear

/**
 * The composer's panel id. A plain `new` opens it with the draft's assumption
 * (if any); `new-<assumptionId>` — what the OST's "Test this assumption" link
 * opens — presets the assumption being tested. Keeps the
 * `?detail=experiment-new:new` shape while letting the URL carry the one bit
 * of context the link adds.
 */
export const EXPERIMENT_COMPOSER_ID = "new"

export function experimentComposerId(assumptionId?: string | null): string {
  return assumptionId ? `${EXPERIMENT_COMPOSER_ID}-${assumptionId}` : EXPERIMENT_COMPOSER_ID
}

export function presetAssumptionFromComposerId(id: string): string | null {
  const prefix = `${EXPERIMENT_COMPOSER_ID}-`
  if (!id.startsWith(prefix)) return null
  return id.slice(prefix.length) || null
}
