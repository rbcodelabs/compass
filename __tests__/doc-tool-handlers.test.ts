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

const mockPrisma = {
  doc: mockDoc,
  workspace: mockWorkspace,
  roadmapItem: mockRoadmapItem,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { createDoc, updateDoc, getDoc } from "@/lib/doc-tool-handlers"

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
