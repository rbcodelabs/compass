// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from "vitest"
import {
  EMPTY_FEEDBACK_DRAFT,
  clearFeedbackDraft,
  feedbackDraftKey,
  isFeedbackDraftEmpty,
  loadFeedbackDraft,
  parseFeedbackDraft,
  saveFeedbackDraft,
  serializeFeedbackDraft,
  type FeedbackDraft,
} from "@/lib/feedback-draft"

const attachment = (restorableUntil: number) => ({
  url: "https://s.public.blob.vercel-storage.com/feedback/ws/a.png",
  receipt: "r",
  filename: "a.png",
  fileType: "image/png",
  fileSize: 10,
  restorableUntil,
})

function installLocalStorage() {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  })
  return store
}

describe("feedback draft", () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = installLocalStorage()
  })

  it("keys drafts per workspace", () => {
    expect(feedbackDraftKey("acme", "core")).not.toBe(feedbackDraftKey("acme", "other"))
  })

  it("round-trips a draft", () => {
    const draft: FeedbackDraft = { type: "BUG", title: "Crash", description: "## Steps", attachments: [attachment(Date.now() + 60_000)] }
    saveFeedbackDraft("k", draft)
    expect(loadFeedbackDraft("k")).toEqual(draft)
  })

  it("removes the stored value instead of saving an empty draft", () => {
    store.set("k", "stale")
    saveFeedbackDraft("k", { ...EMPTY_FEEDBACK_DRAFT, type: "BUG" })
    expect(store.has("k")).toBe(false)
  })

  it("clears", () => {
    saveFeedbackDraft("k", { ...EMPTY_FEEDBACK_DRAFT, title: "x" })
    clearFeedbackDraft("k")
    expect(loadFeedbackDraft("k")).toBeNull()
  })

  it("drops attachments whose receipt the server would no longer accept", () => {
    const now = 1_000_000
    const raw = serializeFeedbackDraft({ type: "IDEA", title: "t", description: "", attachments: [attachment(now - 1), attachment(now + 1)] })
    expect(parseFeedbackDraft(raw, now)?.attachments).toHaveLength(1)
  })

  it.each([
    ["garbage", "{not json"],
    ["wrong version", JSON.stringify({ version: 99, title: "x" })],
    ["a non-object", "42"],
    ["null", null],
  ])("treats %s as no draft", (_label, raw) => {
    expect(parseFeedbackDraft(raw as string | null)).toBeNull()
  })

  it("coerces an unknown type to IDEA and ignores malformed attachments", () => {
    const raw = JSON.stringify({ version: 1, type: "QUESTION", title: "x", description: 5, attachments: [{ url: 1 }] })
    expect(parseFeedbackDraft(raw)).toEqual({ type: "IDEA", title: "x", description: "", attachments: [] })
  })

  it("treats whitespace-only text as empty", () => {
    expect(isFeedbackDraftEmpty({ title: "  ", description: "\n", attachments: [] })).toBe(true)
    expect(isFeedbackDraftEmpty({ title: "", description: "", attachments: [attachment(1)] })).toBe(false)
  })

  it("survives a storage that throws", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("quota") }, removeItem: () => { throw new Error("x") } },
    })
    expect(() => saveFeedbackDraft("k", { ...EMPTY_FEEDBACK_DRAFT, title: "x" })).not.toThrow()
    expect(loadFeedbackDraft("k")).toBeNull()
    expect(() => clearFeedbackDraft("k")).not.toThrow()
  })
})
