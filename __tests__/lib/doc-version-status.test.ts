import { beforeEach, describe, expect, it, vi } from "vitest"

const findFirst = vi.hoisted(() => vi.fn())
const hydrate = vi.hoisted(() => vi.fn())
vi.mock("@/lib/db", () => ({ default: () => ({ docVersion: { findFirst } }) }))
vi.mock("@/lib/document-service", () => ({ hydrateDocument: hydrate }))

import { getDocVersionStatus } from "@/lib/doc-version-status"

const ref = { id: "docver-3", number: 3 }
const current = { title: "Plan", content: "Body" }

beforeEach(() => {
  vi.clearAllMocks()
  findFirst.mockResolvedValue({ title: "Plan", content: "Body", storageProvider: null, contentRef: null })
  hydrate.mockImplementation(async (_ws: string, row: { title: string; content: string | null }) => ({ title: row.title, content: row.content }))
})

describe("getDocVersionStatus", () => {
  it("reports not edited when the pinned version matches the doc", async () => {
    expect(await getDocVersionStatus("ws", "doc", ref, current)).toEqual({ number: 3, editedSince: false })
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "docver-3", docId: "doc" } }))
  })

  it("reports edited when the body changed", async () => {
    expect(await getDocVersionStatus("ws", "doc", ref, { title: "Plan", content: "Body v2" })).toEqual({ number: 3, editedSince: true })
  })

  it("reports edited when only the title changed", async () => {
    expect(await getDocVersionStatus("ws", "doc", ref, { title: "Plan (final)", content: "Body" })).toEqual({ number: 3, editedSince: true })
  })

  it("treats null and empty bodies as the same", async () => {
    findFirst.mockResolvedValue({ title: "Plan", content: null, storageProvider: null, contentRef: null })
    expect(await getDocVersionStatus("ws", "doc", ref, { title: "Plan", content: "" })).toEqual({ number: 3, editedSince: false })
  })

  it("returns null when the version is missing or belongs to another doc", async () => {
    findFirst.mockResolvedValue(null)
    expect(await getDocVersionStatus("ws", "doc", ref, current)).toBeNull()
  })

  it("returns null when the stored body cannot be read", async () => {
    hydrate.mockRejectedValue(new Error("unreadable"))
    expect(await getDocVersionStatus("ws", "doc", ref, current)).toBeNull()
  })
})
