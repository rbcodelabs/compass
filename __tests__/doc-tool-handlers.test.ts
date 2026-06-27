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

const mockPrisma = {
  doc: mockDoc,
  workspace: mockWorkspace,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { createDoc, updateDoc } from "@/lib/doc-tool-handlers"

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
