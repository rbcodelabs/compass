/**
 * Unit tests for lib/doc-versions.ts — the shared snapshot/restore logic used
 * by both the UI's updateDoc/createDocVersion/restoreDocVersion server
 * actions and the MCP doc version tool handlers.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

const mockDoc = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

const mockDocVersion = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
}

const mockPrisma = {
  doc: mockDoc,
  docVersion: mockDocVersion,
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import { maybeSnapshotDocVersion, restoreDocVersionCore } from "@/lib/doc-versions"

const DOC_ID = "doc-1"
const NOW = new Date("2026-07-27T12:00:00.000Z")

const CURRENT_DOC_ROW = {
  title: "Current Title",
  content: "Current content",
  metadata: null,
  icon: "📄",
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mockDoc.findUnique.mockResolvedValue(CURRENT_DOC_ROW)
  mockDocVersion.findFirst.mockResolvedValue(null)
  mockDocVersion.create.mockResolvedValue({ id: "version-new" })
})

afterAll(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------

describe("maybeSnapshotDocVersion", () => {
  it("no-ops when the doc does not exist", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)

    await maybeSnapshotDocVersion(DOC_ID, { authorId: "u1", authorName: "Rick" })

    expect(mockDocVersion.create).not.toHaveBeenCalled()
  })

  it("snapshots the doc's CURRENT (pre-change) state when no prior version exists", async () => {
    mockDocVersion.findFirst.mockResolvedValueOnce(null)

    await maybeSnapshotDocVersion(DOC_ID, { authorId: "u1", authorName: "Rick" })

    expect(mockDocVersion.create).toHaveBeenCalledWith({
      data: {
        docId: DOC_ID,
        title: CURRENT_DOC_ROW.title,
        content: CURRENT_DOC_ROW.content,
        metadata: undefined,
        icon: CURRENT_DOC_ROW.icon,
        label: undefined,
        createdById: "u1",
        createdByName: "Rick",
      },
    })
  })

  it("skips creating a new version when the same author snapshotted within the coalescing window", async () => {
    mockDocVersion.findFirst.mockResolvedValueOnce({
      createdAt: new Date(NOW.getTime() - 60 * 1000), // 1 minute ago
      createdById: "u1",
      createdByName: "Rick",
    })

    await maybeSnapshotDocVersion(DOC_ID, { authorId: "u1", authorName: "Rick" })

    expect(mockDocVersion.create).not.toHaveBeenCalled()
  })

  it("creates a new version when the same author's last snapshot is outside the 5-minute window", async () => {
    mockDocVersion.findFirst.mockResolvedValueOnce({
      createdAt: new Date(NOW.getTime() - 6 * 60 * 1000), // 6 minutes ago
      createdById: "u1",
      createdByName: "Rick",
    })

    await maybeSnapshotDocVersion(DOC_ID, { authorId: "u1", authorName: "Rick" })

    expect(mockDocVersion.create).toHaveBeenCalledTimes(1)
  })

  it("creates a new version within the window when a DIFFERENT author (by id) made the last snapshot", async () => {
    mockDocVersion.findFirst.mockResolvedValueOnce({
      createdAt: new Date(NOW.getTime() - 60 * 1000),
      createdById: "u1",
      createdByName: "Rick",
    })

    await maybeSnapshotDocVersion(DOC_ID, { authorId: "u2", authorName: "Someone Else" })

    expect(mockDocVersion.create).toHaveBeenCalledTimes(1)
  })

  it("falls back to comparing authorName when authorId is absent on both sides (MCP/agent callers)", async () => {
    // Last snapshot was also an MCP caller with no authorId.
    mockDocVersion.findFirst.mockResolvedValueOnce({
      createdAt: new Date(NOW.getTime() - 60 * 1000),
      createdById: null,
      createdByName: "MCP Agent",
    })

    // Same authorName, no authorId -> same author key -> coalesced (skip).
    await maybeSnapshotDocVersion(DOC_ID, { authorName: "MCP Agent" })
    expect(mockDocVersion.create).not.toHaveBeenCalled()
  })

  it("treats a null-authorId caller as a different author than a null-authorId caller with a different name", async () => {
    mockDocVersion.findFirst.mockResolvedValueOnce({
      createdAt: new Date(NOW.getTime() - 60 * 1000),
      createdById: null,
      createdByName: "MCP Agent",
    })

    await maybeSnapshotDocVersion(DOC_ID, { authorName: "A Different Agent" })

    expect(mockDocVersion.create).toHaveBeenCalledTimes(1)
  })

  it("always creates a version when a label is set, even within the coalescing window with the same author", async () => {
    mockDocVersion.findFirst.mockResolvedValueOnce({
      createdAt: new Date(NOW.getTime() - 60 * 1000),
      createdById: "u1",
      createdByName: "Rick",
    })

    await maybeSnapshotDocVersion(DOC_ID, { authorId: "u1", authorName: "Rick", label: "Before rewrite" })

    expect(mockDocVersion.create).toHaveBeenCalledTimes(1)
    const data = mockDocVersion.create.mock.calls[0][0].data
    expect(data.label).toBe("Before rewrite")
  })

  it("a labeled snapshot does not even query for the most recent version (label always bypasses coalescing)", async () => {
    await maybeSnapshotDocVersion(DOC_ID, { authorName: "Rick", label: "Manual save" })

    expect(mockDocVersion.findFirst).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe("restoreDocVersionCore", () => {
  const VERSION_ID = "version-1"
  const OLD_VERSION = {
    id: VERSION_ID,
    docId: DOC_ID,
    title: "Old Title",
    content: "Old content",
    metadata: null,
    icon: "📝",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  }

  beforeEach(() => {
    mockDocVersion.findUnique.mockResolvedValue(OLD_VERSION)
    mockDoc.findUnique.mockResolvedValue({ id: DOC_ID, ...CURRENT_DOC_ROW })
    mockDoc.update.mockResolvedValue({ id: DOC_ID, title: OLD_VERSION.title })
  })

  it("returns null when the version does not exist", async () => {
    mockDocVersion.findUnique.mockResolvedValueOnce(null)

    const result = await restoreDocVersionCore(VERSION_ID, { authorName: "Rick" })

    expect(result).toBeNull()
    expect(mockDoc.update).not.toHaveBeenCalled()
  })

  it("returns null when the version's parent doc no longer exists", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)

    const result = await restoreDocVersionCore(VERSION_ID, { authorName: "Rick" })

    expect(result).toBeNull()
    expect(mockDoc.update).not.toHaveBeenCalled()
  })

  it("snapshots the doc's CURRENT state labeled 'Before restore' before overwriting", async () => {
    await restoreDocVersionCore(VERSION_ID, { authorId: "u1", authorName: "Rick" })

    expect(mockDocVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        docId: DOC_ID,
        label: "Before restore",
        createdById: "u1",
        createdByName: "Rick",
      }),
    })
    // Snapshot happens before the overwrite.
    const snapshotOrder = mockDocVersion.create.mock.invocationCallOrder[0]
    const updateOrder = mockDoc.update.mock.invocationCallOrder[0]
    expect(snapshotOrder).toBeLessThan(updateOrder)
  })

  it("overwrites the doc's live row with the old version's values and sets updatedAt explicitly", async () => {
    await restoreDocVersionCore(VERSION_ID, { authorName: "Rick" })

    expect(mockDoc.update).toHaveBeenCalledWith({
      where: { id: DOC_ID },
      data: {
        title: OLD_VERSION.title,
        content: OLD_VERSION.content,
        metadata: expect.anything(),
        icon: OLD_VERSION.icon,
        updatedAt: expect.any(Date),
      },
    })
  })

  it("returns the restored doc's id/title and the timestamp it was restored from", async () => {
    const result = await restoreDocVersionCore(VERSION_ID, { authorName: "Rick" })

    expect(result).toEqual({
      id: DOC_ID,
      title: OLD_VERSION.title,
      docId: DOC_ID,
      restoredFrom: OLD_VERSION.createdAt,
    })
  })
})
