import { describe, expect, it } from "vitest"
import { refreshEditedMessages } from "@/lib/conversation-message-merge"

const base = { role: "user" as const, content: "old", editedAt: null as string | null, canEdit: false }

describe("refreshEditedMessages", () => {
  it("applies somebody else's edit to an OLDER message, keeping order and identity of untouched rows", () => {
    const current = [{ ...base, id: "a" }, { ...base, id: "b" }]
    const next = refreshEditedMessages(current, [{ ...base, id: "a", content: "new", editedAt: "2026-11-19T10:00:00.000Z", canEdit: true }])
    expect(next.map((m) => m.id)).toEqual(["a", "b"])
    expect(next[0]).toMatchObject({ content: "new", editedAt: "2026-11-19T10:00:00.000Z", canEdit: true })
    expect(next[1]).toBe(current[1])
  })
  it("returns the same array when nothing changed (no re-render)", () => {
    const current = [{ ...base, id: "a", editedAt: "2026-11-19T10:00:00.000Z" }]
    expect(refreshEditedMessages(current, [{ ...current[0]! }])).toBe(current)
  })
  it("ignores messages it does not know and ones that were never edited", () => {
    const current = [{ ...base, id: "a" }]
    expect(refreshEditedMessages(current, [{ ...base, id: "zzz", editedAt: "2026-11-19T10:00:00.000Z" }, { ...base, id: "a", content: "x" }])).toBe(current)
  })
})
