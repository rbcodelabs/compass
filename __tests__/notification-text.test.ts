import { describe, expect, it } from "vitest"
import { formatUnread, humanizeValue, notificationAction, notificationSentence, subjectTypeLabel } from "@/lib/notification-text"

describe("notification wording", () => {
  it("renders a status change with both ends, or just the new status", () => {
    expect(notificationAction({ kind: "STATUS_CHANGED", payload: { from: "TODO", to: "IN_PROGRESS" } })).toBe("changed status from Todo to In progress")
    expect(notificationAction({ kind: "STATUS_CHANGED", payload: { to: "DONE" } })).toBe("set status to Done")
    expect(notificationAction({ kind: "STATUS_CHANGED", payload: {} })).toBe("changed the status")
  })

  it("renders comments, replies and assignment", () => {
    expect(notificationAction({ kind: "COMMENT_ADDED", payload: {} })).toBe("commented")
    expect(notificationAction({ kind: "COMMENT_REPLIED", payload: {} })).toBe("replied to a comment")
    expect(notificationAction({ kind: "ASSIGNED", payload: {} })).toBe("assigned this to you")
  })

  it("never throws on a kind from a newer version", () => {
    expect(notificationAction({ kind: "SOMETHING_NEW", payload: {} })).toBe("made a change")
  })

  it("builds a sentence from the actor name", () => {
    expect(notificationSentence({ kind: "COMMENT_ADDED", actorName: "Ada", payload: {} })).toBe("Ada commented")
  })

  it("humanizes enum values and labels subject types", () => {
    expect(humanizeValue("UNDER_REVIEW")).toBe("Under review")
    expect(humanizeValue(undefined)).toBe("")
    expect(subjectTypeLabel("TASK")).toBe("Task")
    expect(subjectTypeLabel("NEW_TYPE")).toBe("Item")
  })

  it("caps the unread label at 99+", () => {
    expect(formatUnread(3, false)).toBe("3")
    expect(formatUnread(99, false)).toBe("99")
    expect(formatUnread(99, true)).toBe("99+")
    expect(formatUnread(120, false)).toBe("99+")
  })
})
