/**
 * Unit tests for the DocVersion MCP tool handlers (create_doc_version,
 * list_doc_versions, get_doc_version, restore_doc_version).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------

const mockDoc = {
  findUnique: vi.fn(),
}

const mockDocVersion = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
}

const mockPrisma = {
  doc: mockDoc,
  docVersion: mockDocVersion,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// The snapshot/restore mechanics (coalescing, "before restore" safety net)
// have their own dedicated unit tests in __tests__/lib/doc-versions.test.ts —
// here we only assert these handlers call them correctly and shape the
// response text.
const mockMaybeSnapshotDocVersion = vi.fn()
const mockRestoreDocVersionCore = vi.fn()
vi.mock("@/lib/doc-versions", () => ({
  maybeSnapshotDocVersion: (...args: unknown[]) => mockMaybeSnapshotDocVersion(...args),
  restoreDocVersionCore: (...args: unknown[]) => mockRestoreDocVersionCore(...args),
}))

// Import handlers AFTER the mocks are in place
import {
  createDocVersion,
  listDocVersions,
  getDocVersion,
  restoreDocVersion,
} from "@/lib/doc-version-tool-handlers"

// ---------------------------------------------------------------------------

const DOC_ID = "doc-1"
const VERSION_ID = "version-1"

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

const NOW = new Date("2026-07-27T12:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
  mockDoc.findUnique.mockResolvedValue({ id: DOC_ID, title: "Product Vision", updatedAt: NOW })
  mockMaybeSnapshotDocVersion.mockResolvedValue(undefined)
  mockDocVersion.findFirst.mockResolvedValue({
    id: VERSION_ID,
    docId: DOC_ID,
    label: "Snapshot",
    createdByName: "Claude",
    createdAt: NOW,
  })
  mockDocVersion.findMany.mockResolvedValue([])
  mockDocVersion.findUnique.mockResolvedValue({
    id: VERSION_ID,
    docId: DOC_ID,
    title: "Product Vision",
    content: "Full markdown body",
    metadata: null,
    icon: "📄",
    label: null,
    createdByName: "Claude",
    createdAt: NOW,
  })
  mockRestoreDocVersionCore.mockResolvedValue({
    id: DOC_ID,
    title: "Product Vision",
    docId: DOC_ID,
    restoredFrom: NOW,
  })
})

// ---------------------------------------------------------------------------

describe("createDocVersion", () => {
  it("returns a not-found message when the doc does not exist", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)

    const result = await createDocVersion({ docId: "missing-id", authorName: "Claude" })

    expect(textOf(result)).toContain("not found")
    expect(mockMaybeSnapshotDocVersion).not.toHaveBeenCalled()
  })

  it("always snapshots (bypassing coalescing) via a defaulted label when none is given", async () => {
    await createDocVersion({ docId: DOC_ID, authorName: "Claude" })

    expect(mockMaybeSnapshotDocVersion).toHaveBeenCalledWith(DOC_ID, {
      authorName: "Claude",
      label: "Snapshot",
    })
  })

  it("trims and forwards an explicit label", async () => {
    await createDocVersion({ docId: DOC_ID, label: "  Before big rewrite  ", authorName: "Claude" })

    expect(mockMaybeSnapshotDocVersion).toHaveBeenCalledWith(DOC_ID, {
      authorName: "Claude",
      label: "Before big rewrite",
    })
  })

  it("returns a plain ID line for the newly created version (no markdown bold)", async () => {
    const result = await createDocVersion({ docId: DOC_ID, authorName: "Claude" })

    const text = textOf(result)
    expect(text).toContain(`ID: ${VERSION_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})

describe("listDocVersions", () => {
  it("returns a not-found message when the doc does not exist", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)

    const result = await listDocVersions({ docId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockDocVersion.findMany).not.toHaveBeenCalled()
  })

  it("reports no saved versions distinctly from a missing doc, but still shows the current reference point", async () => {
    mockDocVersion.findMany.mockResolvedValueOnce([])

    const result = await listDocVersions({ docId: DOC_ID })

    const text = textOf(result)
    expect(text).toContain("No saved versions yet")
    expect(text).toContain("Current")
    expect(text).toContain(NOW.toISOString())
  })

  it("lists versions newest-first with label, author, and a plain ID line", async () => {
    mockDocVersion.findMany.mockResolvedValueOnce([
      { id: "v2", label: "Before restore", createdByName: "Claude", createdAt: NOW },
      { id: "v1", label: null, createdByName: "Rick", createdAt: new Date("2026-07-20T00:00:00Z") },
    ])

    const result = await listDocVersions({ docId: DOC_ID })

    expect(mockDocVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { docId: DOC_ID }, orderBy: { createdAt: "desc" } })
    )
    const text = textOf(result)
    expect(text).toContain("[Before restore]")
    expect(text).toContain("ID: v2")
    expect(text).toContain("Rick")
    expect(text).toContain("ID: v1")
  })
})

describe("getDocVersion", () => {
  it("returns a not-found message when the version does not exist", async () => {
    mockDocVersion.findUnique.mockResolvedValueOnce(null)

    const result = await getDocVersion({ versionId: "missing-id" })

    expect(textOf(result)).toContain("not found")
  })

  it("returns the full title/content/icon snapshot with a plain ID line", async () => {
    const result = await getDocVersion({ versionId: VERSION_ID })

    const text = textOf(result)
    expect(text).toContain("Product Vision")
    expect(text).toContain("Full markdown body")
    expect(text).toContain("📄")
    expect(text).toContain(`ID: ${VERSION_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("shows a placeholder when the version has no content", async () => {
    mockDocVersion.findUnique.mockResolvedValueOnce({
      id: VERSION_ID,
      docId: DOC_ID,
      title: "Empty Doc",
      content: null,
      metadata: null,
      icon: null,
      label: null,
      createdByName: "Claude",
      createdAt: NOW,
    })

    const result = await getDocVersion({ versionId: VERSION_ID })

    expect(textOf(result)).toContain("(no content)")
  })
})

describe("restoreDocVersion", () => {
  it("returns a not-found message when the version does not exist", async () => {
    mockDocVersion.findUnique.mockResolvedValueOnce(null)

    const result = await restoreDocVersion({ versionId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockRestoreDocVersionCore).not.toHaveBeenCalled()
  })

  it("returns a not-found message when the version's parent doc no longer exists", async () => {
    mockDoc.findUnique.mockResolvedValueOnce(null)

    const result = await restoreDocVersion({ versionId: VERSION_ID })

    expect(textOf(result)).toContain("not found")
    expect(mockRestoreDocVersionCore).not.toHaveBeenCalled()
  })

  it("restores via restoreDocVersionCore, attributing the snapshot to MCP Agent", async () => {
    await restoreDocVersion({ versionId: VERSION_ID })

    expect(mockRestoreDocVersionCore).toHaveBeenCalledWith(VERSION_ID, { authorName: "MCP Agent" })
  })

  it("returns the restored doc's title and a plain ID line", async () => {
    const result = await restoreDocVersion({ versionId: VERSION_ID })

    const text = textOf(result)
    expect(text).toContain("Product Vision")
    expect(text).toContain(`ID: ${DOC_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("handles the race where restoreDocVersionCore itself returns null", async () => {
    mockRestoreDocVersionCore.mockResolvedValueOnce(null)

    const result = await restoreDocVersion({ versionId: VERSION_ID })

    expect(textOf(result)).toContain("not found")
  })
})
