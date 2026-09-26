// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"
import {
  EMPTY_OPPORTUNITY_DRAFT,
  clearOpportunityDraft,
  isOpportunityDraftEmpty,
  loadOpportunityDraft,
  opportunityComposerId,
  opportunityDraftKey,
  parseOpportunityDraft,
  presetStatusFromComposerId,
  saveOpportunityDraft,
  serializeOpportunityDraft,
  type OpportunityDraft,
} from "@/lib/opportunity-draft"
import { feedbackDraftKey } from "@/lib/feedback-draft"

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

const full: OpportunityDraft = {
  title: "Onboarding stalls",
  description: "## Who's affected\n\nNew admins",
  customerSegment: "SMB",
  status: "VALIDATING",
  squadId: "sq-1",
  keyResultId: "kr-1",
  feedbackIds: ["fb-1", "fb-2"],
}

describe("opportunity draft", () => {
  let store: Map<string, string>
  beforeEach(() => {
    store = installLocalStorage()
  })

  it("is keyed per workspace and never collides with the feedback draft", () => {
    expect(opportunityDraftKey("acme", "core")).toBe("compass:opportunity-draft:v1:acme/core")
    expect(opportunityDraftKey("acme", "core")).not.toBe(opportunityDraftKey("acme", "other"))
    expect(opportunityDraftKey("acme", "core")).not.toBe(feedbackDraftKey("acme", "core"))
  })

  it("round-trips every field", () => {
    expect(parseOpportunityDraft(serializeOpportunityDraft(full))).toEqual(full)
  })

  it("treats a draft with only the preset status as empty, but any chosen link as content", () => {
    expect(isOpportunityDraftEmpty({ ...EMPTY_OPPORTUNITY_DRAFT, status: "ACTIVE" })).toBe(true)
    expect(isOpportunityDraftEmpty({ ...EMPTY_OPPORTUNITY_DRAFT, title: "  " })).toBe(true)
    expect(isOpportunityDraftEmpty({ ...EMPTY_OPPORTUNITY_DRAFT, keyResultId: "kr-1" })).toBe(false)
    expect(isOpportunityDraftEmpty({ ...EMPTY_OPPORTUNITY_DRAFT, feedbackIds: ["fb-1"] })).toBe(false)
  })

  it("tolerates garbage: bad JSON, wrong version, unknown status, non-string ids", () => {
    expect(parseOpportunityDraft("{not json")).toBeNull()
    expect(parseOpportunityDraft(JSON.stringify({ version: 99, title: "x" }))).toBeNull()
    const parsed = parseOpportunityDraft(
      JSON.stringify({ version: 1, title: "x", status: "ARCHIVED", squadId: 7, feedbackIds: ["fb-1", 3, "fb-1"] }),
    )
    expect(parsed).toEqual({ ...EMPTY_OPPORTUNITY_DRAFT, title: "x", feedbackIds: ["fb-1"] })
  })

  it("encodes a column's status preset in the composer panel id and reads it back", () => {
    expect(opportunityComposerId()).toBe("new")
    expect(opportunityComposerId("VALIDATING")).toBe("new-validating")
    expect(opportunityComposerId("ARCHIVED")).toBe("new")
    expect(presetStatusFromComposerId("new-validating")).toBe("VALIDATING")
    expect(presetStatusFromComposerId("new")).toBeNull()
    expect(presetStatusFromComposerId("new-archived")).toBeNull()
    expect(presetStatusFromComposerId("new-bogus")).toBeNull()
  })

  it("saves, loads, removes when emptied, and clears", () => {
    const key = opportunityDraftKey("acme", "core")
    saveOpportunityDraft(key, full)
    expect(loadOpportunityDraft(key)).toEqual(full)
    saveOpportunityDraft(key, EMPTY_OPPORTUNITY_DRAFT)
    expect(store.has(key)).toBe(false)
    saveOpportunityDraft(key, full)
    clearOpportunityDraft(key)
    expect(loadOpportunityDraft(key)).toBeNull()
  })
})
