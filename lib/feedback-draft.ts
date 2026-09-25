/**
 * In-progress "New feedback" drafts, persisted to localStorage per workspace.
 *
 * The composer is a panel that can be closed (Esc, X, navigating away) or lost
 * to a reload at any moment, so every keystroke is saved here and restored on
 * the next open. Only a *successful* submit or an explicit, confirmed Discard
 * clears it.
 *
 * Attachments are persisted too, but only ones that finished uploading — a
 * `File` cannot be serialized, and an in-flight upload dies with the page.
 * Each carries `restorableUntil`: after that the server would refuse its
 * receipt anyway, so it is dropped on load rather than failing on submit.
 *
 * Every reader is tolerant. A hand-edited, truncated or older-format value
 * becomes "no draft", never a thrown error that breaks the panel.
 */
import type { FeedbackTypeValue } from "@/lib/feedback-meta"
import { FEEDBACK_ATTACHMENT_MAX_COUNT } from "@/lib/feedback-attachment-rules"

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

const VERSION = 1

export function feedbackDraftKey(orgSlug: string, workspaceSlug: string): string {
  return `compass:feedback-draft:v${VERSION}:${orgSlug}/${workspaceSlug}`
}

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

export function parseFeedbackDraft(raw: string | null, now = Date.now()): FeedbackDraft | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const v = parsed as Record<string, unknown>
  if (v.version !== VERSION) return null
  const draft: FeedbackDraft = {
    type: v.type === "BUG" ? "BUG" : "IDEA",
    title: typeof v.title === "string" ? v.title : "",
    description: typeof v.description === "string" ? v.description : "",
    attachments: Array.isArray(v.attachments)
      ? v.attachments
          .filter(isDraftAttachment)
          .filter((attachment) => attachment.restorableUntil > now)
          .slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT)
      : [],
  }
  return isFeedbackDraftEmpty(draft) ? null : draft
}

export function serializeFeedbackDraft(draft: FeedbackDraft): string {
  return JSON.stringify({ version: VERSION, ...draft })
}

/** Storage can throw (quota, privacy mode, disabled). A draft is a nicety. */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export function loadFeedbackDraft(key: string): FeedbackDraft | null {
  try {
    return parseFeedbackDraft(storage()?.getItem(key) ?? null)
  } catch {
    return null
  }
}

export function saveFeedbackDraft(key: string, draft: FeedbackDraft): void {
  try {
    const store = storage()
    if (!store) return
    if (isFeedbackDraftEmpty(draft)) store.removeItem(key)
    else store.setItem(key, serializeFeedbackDraft(draft))
  } catch {
    // Quota or privacy-mode failure: the in-memory draft is still intact.
  }
}

export function clearFeedbackDraft(key: string): void {
  try {
    storage()?.removeItem(key)
  } catch {
    // Nothing useful to do — see saveFeedbackDraft.
  }
}
