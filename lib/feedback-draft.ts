/**
 * In-progress "New feedback" drafts, persisted to localStorage per workspace.
 * Storage, keying and tolerant parsing are shared with every composer — see
 * lib/composer-draft.ts. This module only knows feedback's fields.
 *
 * Attachments are persisted too, but only ones that finished uploading — a
 * `File` cannot be serialized, and an in-flight upload dies with the page.
 * Each carries `restorableUntil`: after that the server would refuse its
 * receipt anyway, so it is dropped on load rather than failing on submit.
 */
import type { FeedbackTypeValue } from "@/lib/feedback-meta"
import { FEEDBACK_ATTACHMENT_MAX_COUNT } from "@/lib/feedback-attachment-rules"
import { createComposerDraftStore, draftString } from "@/lib/composer-draft"

export type DraftAttachment = {
  url: string
  receipt: string
  filename: string
  fileType: string
  fileSize: number
  /** Epoch ms after which the server will no longer accept the receipt. */
  restorableUntil: number
}

export type FeedbackDraft = {
  type: FeedbackTypeValue
  title: string
  description: string
  attachments: DraftAttachment[]
}

export const EMPTY_FEEDBACK_DRAFT: FeedbackDraft = Object.freeze({
  type: "IDEA",
  title: "",
  description: "",
  attachments: [],
}) as FeedbackDraft

/** A draft worth keeping (and worth confirming before throwing away). */
export function isFeedbackDraftEmpty(draft: Pick<FeedbackDraft, "title" | "description" | "attachments">): boolean {
  return !draft.title.trim() && !draft.description.trim() && draft.attachments.length === 0
}

function isDraftAttachment(value: unknown): value is DraftAttachment {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.url === "string" &&
    typeof v.receipt === "string" &&
    typeof v.filename === "string" &&
    typeof v.fileType === "string" &&
    typeof v.fileSize === "number" &&
    typeof v.restorableUntil === "number"
  )
}

const store = createComposerDraftStore<FeedbackDraft>({
  kind: "feedback",
  version: 1,
  isEmpty: isFeedbackDraftEmpty,
  fromRecord: (v, now) => ({
    type: v.type === "BUG" ? "BUG" : "IDEA",
    title: draftString(v.title),
    description: draftString(v.description),
    attachments: Array.isArray(v.attachments)
      ? v.attachments
          .filter(isDraftAttachment)
          .filter((attachment) => attachment.restorableUntil > now)
          .slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT)
      : [],
  }),
})

export const feedbackDraftKey = store.key
export const parseFeedbackDraft = store.parse
export const serializeFeedbackDraft = store.serialize
export const loadFeedbackDraft = store.load
export const saveFeedbackDraft = store.save
export const clearFeedbackDraft = store.clear
