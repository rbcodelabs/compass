import { describe, expect, it, vi } from "vitest"
import { canonicalRedirectSegment, resolveDisplayId, resolveWorkItem, resolveWorkItemId } from "@/lib/work-item-resolve"

const WS = "11111111-1111-4111-8111-111111111111"
const UUID = "22222222-2222-4222-8222-222222222222"

function fakeDb(row: { id: string; seqPrefix: string | null; seqNumber: number | null } | null) {
  const findFirst = vi.fn(async () => row)
  return { db: { task: { findFirst }, opportunity: { findFirst }, keyResult: { findFirst }, feedbackItem: { findFirst } }, findFirst }
}

describe("resolveWorkItem", () => {
  it("looks a display ID up by (workspace, prefix, number), case-insensitively", async () => {
    const { db, findFirst } = fakeDb({ id: UUID, seqPrefix: "TASK", seqNumber: 5 })
    const result = await resolveWorkItem(db, WS, "task", "task-005")
    expect(result).toEqual({ ok: true, type: "task", id: UUID, displayId: "TASK-5", canonical: "TASK-5" })
    expect(findFirst).toHaveBeenCalledWith({ where: { workspaceId: WS, seqPrefix: "TASK", seqNumber: 5 }, select: { id: true, seqPrefix: true, seqNumber: true } })
  })

  it("looks a UUID up by id inside the workspace and reports the row's display ID", async () => {
    const { db, findFirst } = fakeDb({ id: UUID, seqPrefix: "TASK", seqNumber: 7 })
    const result = await resolveWorkItem(db, WS, "task", UUID.toUpperCase())
    expect(result).toMatchObject({ ok: true, id: UUID, displayId: "TASK-7", canonical: "TASK-7" })
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: UUID, workspaceId: WS } }))
  })

  it("scopes a key result UUID through its objective, since workspace_id is NULL until 093", async () => {
    const { db, findFirst } = fakeDb({ id: UUID, seqPrefix: null, seqNumber: null })
    await resolveWorkItem(db, WS, "keyResult", UUID)
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: UUID, objective: { workspaceId: WS } } }))
  })

  it("keeps an un-numbered row on its UUID", async () => {
    const { db } = fakeDb({ id: UUID, seqPrefix: null, seqNumber: null })
    const result = await resolveWorkItem(db, WS, "task", UUID)
    expect(result).toEqual({ ok: true, type: "task", id: UUID, displayId: null, canonical: UUID })
  })

  it("is not_found for a row outside the workspace, for a UUID and for a display ID alike", async () => {
    const { db } = fakeDb(null)
    expect(await resolveWorkItem(db, WS, "task", UUID)).toMatchObject({ ok: false, reason: "not_found" })
    expect(await resolveWorkItem(db, WS, "task", "TASK-5")).toMatchObject({ ok: false, reason: "not_found" })
  })

  it("names the real type when a display ID is given to the wrong entity, without touching the database", async () => {
    const { db, findFirst } = fakeDb(null)
    expect(await resolveWorkItem(db, WS, "opportunity", "TASK-5")).toEqual({ ok: false, reason: "wrong_type", message: "TASK-5 is a Task" })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("rejects junk without a query", async () => {
    const { db, findFirst } = fakeDb(null)
    for (const ref of ["", "nonsense", "TASK-0", "XYZ-3", "TASK-", "1; DROP TABLE tasks"]) {
      expect(await resolveWorkItem(db, WS, "task", ref)).toMatchObject({ ok: false, reason: "invalid" })
    }
    expect(findFirst).not.toHaveBeenCalled()
  })

  it("uses the feedbackItem delegate for feedback", async () => {
    const { db, findFirst } = fakeDb({ id: UUID, seqPrefix: "FB", seqNumber: 2 })
    expect(await resolveWorkItem(db, WS, "feedback", "FB-2")).toMatchObject({ ok: true, displayId: "FB-2" })
    expect(findFirst).toHaveBeenCalled()
  })
})

describe("resolveDisplayId / resolveWorkItemId / canonicalRedirectSegment", () => {
  it("infers the type from the prefix, and refuses a bare UUID", async () => {
    const { db } = fakeDb({ id: UUID, seqPrefix: "TASK", seqNumber: 5 })
    expect(await resolveDisplayId(db, WS, "TASK-5")).toMatchObject({ ok: true, type: "task" })
    expect(await resolveDisplayId(db, WS, UUID)).toMatchObject({ ok: false, reason: "invalid" })
  })

  it("resolveWorkItemId returns the UUID or null", async () => {
    expect(await resolveWorkItemId(fakeDb({ id: UUID, seqPrefix: "TASK", seqNumber: 5 }).db, WS, "task", "TASK-5")).toBe(UUID)
    expect(await resolveWorkItemId(fakeDb(null).db, WS, "task", "TASK-5")).toBeNull()
  })

  it("redirects a UUID URL of a numbered row, and recases a display ID, but leaves canonical and un-numbered URLs alone", () => {
    const numbered = { type: "task", id: UUID, displayId: "TASK-5", canonical: "TASK-5" } as const
    expect(canonicalRedirectSegment(UUID, numbered)).toBe("TASK-5")
    expect(canonicalRedirectSegment("task-5", numbered)).toBe("TASK-5")
    expect(canonicalRedirectSegment("TASK-5", numbered)).toBeNull()
    expect(canonicalRedirectSegment(UUID, { type: "task", id: UUID, displayId: null, canonical: UUID })).toBeNull()
  })
})
