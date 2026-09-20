/**
 * Unit tests for the Docs MCP tool handlers.
 * Focuses on the stripFrontmatter helper which is the key behaviour
 * introduced in PR #25.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------

const mockDoc = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}

const mockWorkspace = {
  findUnique: vi.fn(),
}

const mockRoadmapItem = {
  findUnique: vi.fn(),
}

// updateDoc now snapshots the doc's pre-change state via
// maybeSnapshotDocVersion (lib/doc-versions.ts) before applying an update —
// that module resolves getPrisma() from this same mock, so docVersion needs
// mocking here too even though this file's own assertions are about
// frontmatter handling, not versioning (see doc-version-tool-handlers.test.ts
// and lib/doc-versions.test.ts for that coverage).
const mockDocVersion = {
  findFirst: vi.fn(),
  create: vi.fn(),
}

const mockPrisma = {
  doc: mockDoc,
  workspace: mockWorkspace,
  roadmapItem: mockRoadmapItem,
  docVersion: mockDocVersion,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { createDoc, updateDoc, getDoc, listDocs } from "@/lib/doc-tool-handlers"

// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1"
const DOC_ID = "doc-1"

const mockWorkspaceRow = {
  name: "Compass",
  slug: "compass",
  organization: { slug: "rbcodelabs" },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWorkspace.findUnique.mockResolvedValue(mockWorkspaceRow)
  mockDoc.findFirst.mockResolvedValue(null)
  mockDoc.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: DOC_ID, ...data })
  )
  mockDoc.findUnique.mockResolvedValue({ title: "Test Doc" })
  mockDocVersion.findFirst.mockResolvedValue(null)
  mockDocVersion.create.mockResolvedValue({ id: "version-1" })
  mockDoc.update.mockImplementation(({ data }) =>
    Promise.resolve({ id: DOC_ID, title: "Test Doc", icon: null, ...data, updatedAt: new Date() })
  )
})

// ---------------------------------------------------------------------------

describe("createDoc — frontmatter stripping", () => {
  it("strips YAML frontmatter before storing", async () => {
    const contentWithFrontmatter = `---
tags: [compass, vision]
created: 2026-06-27
---

# Product Vision

Some content here.`

    await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Vision",
      content: contentWithFrontmatter,
    })

    const stored = mockDoc.create.mock.calls[0][0].data.content as string
    expect(stored).not.toContain("---")
    expect(stored).not.toContain("tags:")
    expect(stored).not.toContain("created:")
    expect(stored).toContain("# Product Vision")
    expect(stored).toContain("Some content here.")
  })

  it("passes through content without frontmatter unchanged", async () => {
    const cleanContent = `# Product Vision\n\nSome content here.`

    await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Vision",
      content: cleanContent,
    })

    const stored = mockDoc.create.mock.calls[0][0].data.content as string
    expect(stored).toBe(cleanContent)
  })

  it("handles content that is only frontmatter (edge case)", async () => {
    const onlyFrontmatter = `---
tags: [compass]
---
`
    await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Empty",
      content: onlyFrontmatter,
    })

    const stored = mockDoc.create.mock.calls[0][0].data.content as string
    expect(stored).toBe("")
  })

  it("stores null when no content provided", async () => {
    await createDoc({ workspaceId: WORKSPACE_ID, title: "Empty" })

    const stored = mockDoc.create.mock.calls[0][0].data.content
    expect(stored).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe("updateDoc — frontmatter stripping", () => {
  it("strips YAML frontmatter before updating", async () => {
    const contentWithFrontmatter = `---
tags: [compass, direction]
---

# Product Direction

Focus areas.`

    await updateDoc({ docId: DOC_ID, content: contentWithFrontmatter })

    const stored = mockDoc.update.mock.calls[0][0].data.content as string
    expect(stored).not.toContain("---")
    expect(stored).not.toContain("tags:")
    expect(stored).toContain("# Product Direction")
    expect(stored).toContain("Focus areas.")
  })

  it("passes through clean content unchanged", async () => {
    const cleanContent = `# Product Direction\n\nFocus areas.`

    await updateDoc({ docId: DOC_ID, content: cleanContent })

    const stored = mockDoc.update.mock.calls[0][0].data.content as string
    expect(stored).toBe(cleanContent)
  })
})

// ---------------------------------------------------------------------------

// Regression: createDoc used to emit `URL: /{org}/{ws}/docs` — a *relative*
// path pointing at the docs index rather than the doc that was just created.
// An MCP client has no origin to resolve that against, and even resolved it
// opened the wrong page.
describe("createDoc — deeplink", () => {
  it("returns an absolute URL to the created doc, not the docs index", async () => {
    const result = await createDoc({ workspaceId: WORKSPACE_ID, title: "Vision" })

    const text = result.content[0].text
    expect(text).toContain(`URL: http://localhost:3000/rbcodelabs/compass/docs/${DOC_ID}`)
    expect(text).not.toMatch(/URL: \/rbcodelabs\/compass\/docs$/m)
    expect(result.structuredContent.data).toMatchObject({
      url: `http://localhost:3000/rbcodelabs/compass/docs/${DOC_ID}`,
    })
  })

  it("still creates the doc, with no URL line, when the origin is unconfigured", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")

    const result = await createDoc({ workspaceId: WORKSPACE_ID, title: "Vision" })

    expect(mockDoc.create).toHaveBeenCalled()
    expect(result.content[0].text).toContain(`ID: ${DOC_ID}`)
    expect(result.content[0].text).not.toContain("URL:")
    expect(result.structuredContent.data).toMatchObject({ url: null })
    vi.unstubAllEnvs()
  })
})

describe("createDoc — roadmapItemId / docType (GTM Positioning Brief)", () => {
  const ROADMAP_ITEM_ID = "ri-1"

  it("returns a not-found message when roadmapItemId does not resolve to a real roadmap item", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce(null)

    const result = await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Launch Brief",
      roadmapItemId: "missing-item",
    })

    expect(result.content[0].text).toContain("not found")
    expect(mockDoc.create).not.toHaveBeenCalled()
  })

  it("returns a conflict message with the existing doc's ID when the roadmap item already has a linked doc", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce({ id: ROADMAP_ITEM_ID, title: "Ship payments" })
    mockDoc.findUnique.mockResolvedValueOnce({ id: "existing-brief-1", title: "Existing Brief" })

    const result = await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Launch Brief",
      roadmapItemId: ROADMAP_ITEM_ID,
    })

    const text = result.content[0].text
    expect(text).toContain("already has a linked doc")
    expect(text).toContain("ID: existing-brief-1")
    expect(mockDoc.create).not.toHaveBeenCalled()
  })

  it("auto-fills the GTM_POSITIONING_BRIEF_TEMPLATE when docType is GTM_POSITIONING_BRIEF and no content is given", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce({ id: ROADMAP_ITEM_ID, title: "Ship payments" })
    mockDoc.findUnique.mockResolvedValueOnce(null)

    await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Launch Brief",
      roadmapItemId: ROADMAP_ITEM_ID,
      docType: "GTM_POSITIONING_BRIEF",
    })

    const data = mockDoc.create.mock.calls[0][0].data
    expect(data.content).toContain("## Problem Statement")
    expect(data.content).toContain("## Target Audience")
    expect(data.content).toContain("## Core Message")
    expect(data.content).toContain("## Proof Points")
    expect(data.content).toContain("## Competitive Differentiation")
    expect(data.docType).toBe("GTM_POSITIONING_BRIEF")
    expect(data.roadmapItemId).toBe(ROADMAP_ITEM_ID)
  })

  it("prefers explicit content over the template when both docType and content are given", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce({ id: ROADMAP_ITEM_ID, title: "Ship payments" })
    mockDoc.findUnique.mockResolvedValueOnce(null)

    await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Launch Brief",
      roadmapItemId: ROADMAP_ITEM_ID,
      docType: "GTM_POSITIONING_BRIEF",
      content: "# Custom brief content",
    })

    const data = mockDoc.create.mock.calls[0][0].data
    expect(data.content).toBe("# Custom brief content")
    expect(data.content).not.toContain("## Problem Statement")
  })

  it("defaults docType to STANDARD when omitted", async () => {
    await createDoc({ workspaceId: WORKSPACE_ID, title: "Plain doc" })

    const data = mockDoc.create.mock.calls[0][0].data
    expect(data.docType).toBe("STANDARD")
    expect(data.roadmapItemId).toBeNull()
  })

  it("includes the linked roadmap item and doc type in the response text", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce({ id: ROADMAP_ITEM_ID, title: "Ship payments" })
    mockDoc.findUnique.mockResolvedValueOnce(null)

    const result = await createDoc({
      workspaceId: WORKSPACE_ID,
      title: "Launch Brief",
      roadmapItemId: ROADMAP_ITEM_ID,
      docType: "GTM_POSITIONING_BRIEF",
    })

    const text = result.content[0].text
    expect(text).toContain(`Linked Roadmap Item: ${ROADMAP_ITEM_ID}`)
    expect(text).toContain("Doc Type: GTM_POSITIONING_BRIEF")
  })
})

// ---------------------------------------------------------------------------

describe("getDoc — roadmapItemId / docType exposure", () => {
  it("surfaces the linked roadmap item and doc type when set", async () => {
    mockDoc.findUnique.mockResolvedValueOnce({
      id: DOC_ID,
      title: "Launch Brief",
      icon: null,
      content: "## Problem Statement",
      metadata: null,
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      parent: null,
      children: [],
      docType: "GTM_POSITIONING_BRIEF",
      roadmapItemId: "ri-1",
    })

    const result = await getDoc({ docId: DOC_ID })

    const text = result.content[0].text
    expect(text).toContain("Doc Type: GTM_POSITIONING_BRIEF")
    expect(text).toContain("Linked Roadmap Item: ri-1")
  })

  it("omits doc type / linked roadmap item lines for a standard, unlinked doc", async () => {
    mockDoc.findUnique.mockResolvedValueOnce({
      id: DOC_ID,
      title: "Plain doc",
      icon: null,
      content: "Some content",
      metadata: null,
      updatedAt: new Date("2026-07-01T00:00:00Z"),
      parent: null,
      children: [],
      docType: "STANDARD",
      roadmapItemId: null,
    })

    const result = await getDoc({ docId: DOC_ID })

    const text = result.content[0].text
    expect(text).not.toContain("Doc Type:")
    expect(text).not.toContain("Linked Roadmap Item:")
  })
})

// ─── listDocs recency filtering, sorting, and tree integrity ─────────────────

describe("listDocs recency filtering and sorting", () => {
  function doc(id: string, parentId: string | null = null, children = 0) {
    return { id, title: `Doc ${id}`, icon: null, parentId, sortOrder: 0, updatedAt: new Date("2026-09-01T00:00:00.000Z"), _count: { children } }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspace.findUnique.mockResolvedValue({ name: "Compass" })
    mockDoc.findMany.mockResolvedValue([doc("root")])
  })

  function queryFor() {
    return mockDoc.findMany.mock.calls[0][0] as { where: Record<string, unknown>; orderBy: unknown }
  }

  it("keeps parentId/sortOrder/createdAt as the default ordering when sort is absent", async () => {
    await listDocs({ workspaceId: WORKSPACE_ID })

    // The indented tree is built off this ordering; changing the default would
    // reshuffle sibling order for every existing caller.
    expect(queryFor().orderBy).toEqual([{ parentId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }])
    expect(queryFor().where).toEqual({ workspaceId: WORKSPACE_ID })
  })

  it("filters on a closed recency window", async () => {
    await listDocs({
      workspaceId: WORKSPACE_ID,
      updatedSince: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-09-10T00:00:00.000Z",
    })

    expect(queryFor().where.updatedAt).toEqual({
      gte: new Date("2026-09-01T00:00:00.000Z"),
      lt: new Date("2026-09-10T00:00:00.000Z"),
    })
  })

  it("sorts most recently updated first with a stable id tiebreaker", async () => {
    await listDocs({ workspaceId: WORKSPACE_ID, sort: "recentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "desc" }, { id: "asc" }])
  })

  it("sorts least recently updated first for stale-work scans", async () => {
    await listDocs({ workspaceId: WORKSPACE_ID, sort: "leastRecentlyUpdated" })

    expect(queryFor().orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }])
  })


  it("still nests children under their parent on an unfiltered call", async () => {
    mockDoc.findMany.mockResolvedValue([doc("parent", null, 1), doc("child", "parent")])

    const result = await listDocs({ workspaceId: WORKSPACE_ID })
    const text = result.content[0].text

    expect(text).toContain("• **Doc parent** (1 children)")
    // Two-space indent marks the child as nested rather than top-level.
    expect(text).toContain("  • **Doc child**")
  })

  it("renders a matching child at the top level when the recency filter excluded its parent", async () => {
    // Only the child matched the window; its parent is absent from the result set.
    mockDoc.findMany.mockResolvedValue([doc("orphan", "filtered-out-parent")])

    const result = await listDocs({ workspaceId: WORKSPACE_ID, updatedSince: "2026-09-01T00:00:00.000Z" })
    const data = result.structuredContent.data as { items: Array<{ id: string }>; count: number }

    // Before orphan promotion this doc was counted but unreachable from any
    // root, so it vanished from the rendered tree while count still said 1.
    expect(result.content[0].text).toContain("• **Doc orphan**")
    expect(result.content[0].text).not.toContain("  • **Doc orphan**")
    expect(data.count).toBe(1)
    expect(data.items.map((item) => item.id)).toEqual(["orphan"])
  })

  it("keeps count equal to the number of docs that matched, not the docs rendered", async () => {
    mockDoc.findMany.mockResolvedValue([doc("a", "missing-1"), doc("b", "missing-2")])

    const result = await listDocs({ workspaceId: WORKSPACE_ID, updatedBefore: "2026-09-10T00:00:00.000Z" })
    const data = result.structuredContent.data as { count: number }

    // Promotion deliberately does NOT fetch the absent parents, so no
    // non-matching doc is smuggled into the result.
    expect(data.count).toBe(2)
    expect(mockDoc.findMany).toHaveBeenCalledTimes(1)
  })

  it("reports an empty recency window as a success, not a failure", async () => {
    // Revised after exercising this live over MCP. The earlier expectation here
    // was ok:false, which mirrored the unfiltered empty-workspace branch — but
    // for a recency window "nothing changed" is the normal answer a digest
    // caller expects on a quiet day, and ok:false reads as an error and invites
    // pointless retries. That defeats the purpose of the filter.
    mockDoc.findMany.mockResolvedValue([])

    const result = await listDocs({ workspaceId: WORKSPACE_ID, updatedSince: "2099-01-01T00:00:00.000Z" })

    expect(result.content[0].text).toContain("No docs updated in the requested window")
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.data).toEqual({ items: [], count: 0 })
  })

  it("still fails for an entirely empty workspace when no window was requested", async () => {
    // The unfiltered empty case keeps its original behaviour so existing
    // callers see no change.
    mockDoc.findMany.mockResolvedValue([])

    const result = await listDocs({ workspaceId: WORKSPACE_ID })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("No docs found")
  })
})
