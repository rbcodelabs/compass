/**
 * Unit tests for the Feedback MCP tool handlers:
 *   - createFeedback
 *   - getFeedbackItem
 *   - updateFeedbackStatus
 *   - linkFeedbackToOpportunity
 *
 * Prisma is mocked entirely — no real DB connection is used.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------
// We mock the entire @/lib/db module so getPrisma() returns a controlled mock.

const mockFeedbackItem = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}

const mockOpportunity = {
  findUnique: vi.fn(),
}

const mockRoadmapItem = {
  findFirst: vi.fn(),
  create: vi.fn(),
}

const mockWorkspace = {
  findUnique: vi.fn(),
}

const mockFeedbackAttachment = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
}

const mockPrisma = {
  feedbackItem: mockFeedbackItem,
  opportunity: mockOpportunity,
  roadmapItem: mockRoadmapItem,
  workspace: mockWorkspace,
  feedbackAttachment: mockFeedbackAttachment,
  $transaction: vi.fn(),
}

const {
  mockBlobPut,
  mockBlobDelete,
  mockBlobHead,
  mockGenerateClientToken,
} = vi.hoisted(() => ({
  mockBlobPut: vi.fn(),
  mockBlobDelete: vi.fn(),
  mockBlobHead: vi.fn(),
  mockGenerateClientToken: vi.fn(),
}))

vi.mock("@vercel/blob", () => ({
  put: mockBlobPut,
  del: mockBlobDelete,
  head: mockBlobHead,
}))

vi.mock("@vercel/blob/client", () => ({
  generateClientTokenFromReadWriteToken: mockGenerateClientToken,
}))

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import {
  createFeedback,
  getFeedbackItem,
  updateFeedbackStatus,
  linkFeedbackToOpportunity,
  updateFeedbackType,
  promoteFeedbackToRoadmap,
} from "@/lib/feedback-tool-handlers"
import * as feedbackHandlers from "@/lib/feedback-tool-handlers"
import { prepareFeedbackAttachmentUpload } from "@/lib/feedback-attachments"

// ---------------------------------------------------------------------------

const FEED_ID = "11111111-1111-1111-1111-111111111111"
const OPP_ID = "22222222-2222-2222-2222-222222222222"
const WS_ID = "33333333-3333-3333-3333-333333333333"
const workspaceContext = {
  id: WS_ID,
  slug: "compass",
  organization: { slug: "rbcodelabs" },
}

const sampleItem = {
  id: FEED_ID,
  workspaceId: WS_ID,
  opportunityId: null,
  title: "Dark mode support",
  description: "Users want a dark mode option.",
  type: "IDEA",
  submitterName: "Alice",
  submitterEmail: "alice@example.com",
  status: "OPEN",
  voteCount: 5,
  tags: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  opportunity: null,
  attachments: [],
  workspace: {
    slug: "compass",
    organization: { slug: "rbcodelabs" },
  },
}

const sampleOpportunity = {
  id: OPP_ID,
  title: "Improve visual accessibility",
  status: "EXPLORING",
  workspaceId: WS_ID,
}

beforeEach(() => {
  vi.resetAllMocks()
  mockPrisma.$transaction.mockImplementation(async (callback: (tx: typeof mockPrisma) => unknown) => callback(mockPrisma))
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_secret"
  process.env.NEXT_PUBLIC_APP_URL = "https://compass.rbcodelabs.com"
})

// ---------------------------------------------------------------------------
// createFeedback
// ---------------------------------------------------------------------------

describe("createFeedback", () => {
  it("uploads inline screenshots and creates their attachment rows atomically", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({
      id: WS_ID,
      slug: "compass",
      organization: { slug: "rbcodelabs" },
    })
    mockBlobPut.mockResolvedValueOnce({
      url: "https://store.public.blob.vercel-storage.com/screenshot.png",
    })
    mockFeedbackItem.create.mockResolvedValueOnce({
      ...sampleItem,
      attachments: [{
        id: "attachment-1",
        url: "https://store.public.blob.vercel-storage.com/screenshot.png",
        filename: "screenshot.png",
        fileType: "image/png",
        fileSize: 3,
      }],
    })

    const result = await createFeedback({
      workspaceId: WS_ID,
      title: "Dark mode support",
      attachments: [{
        filename: "screenshot.png",
        data: "data:image/png;base64,UE5H",
      }],
    })

    expect(mockBlobPut).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^feedback/${WS_ID}/`)),
      Buffer.from("PNG"),
      expect.objectContaining({ access: "public", contentType: "image/png" }),
    )
    expect(mockFeedbackItem.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attachments: {
          create: [{
            id: expect.any(String),
            url: "https://store.public.blob.vercel-storage.com/screenshot.png",
            filename: "screenshot.png",
            fileType: "image/png",
            fileSize: 3,
          }],
        },
      }),
    }))
    expect(result.content[0].text).toContain("URL: https://compass.rbcodelabs.com/rbcodelabs/compass/feedback?detail=feedback%3A")
  })

  it("creates a feedback item with source MCP and defaults type to IDEA", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    mockFeedbackItem.create.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      type: "IDEA",
      status: "OPEN",
    })

    const result = await createFeedback({ workspaceId: WS_ID, title: "Dark mode support" })
    const text = result.content[0].text

    expect(text).toContain("Feedback item created")
    expect(text).toContain(`ID: ${FEED_ID}`)
    expect(text).toContain("Dark mode support")
    expect(text).toContain("Type: IDEA")
    // structured-output envelope accompanies the text, unchanged
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.message).toBe(text)
    expect(result.structuredContent.data).toMatchObject({ id: FEED_ID, type: "IDEA" })
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        workspaceId: WS_ID,
        title: "Dark mode support",
        description: null,
        type: "IDEA",
        submitterName: null,
        submitterEmail: null,
        source: "MCP",
      },
    })
  })

  it("passes through an explicit type of BUG", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    mockFeedbackItem.create.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Login button broken",
      type: "BUG",
      status: "OPEN",
    })

    const result = await createFeedback({ workspaceId: WS_ID, title: "Login button broken", type: "BUG" })

    expect(result.content[0].text).toContain("Type: BUG")
    expect(mockFeedbackItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "BUG" }) })
    )
  })

  it("trims and forwards description, submitterName, and submitterEmail", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    mockFeedbackItem.create.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      type: "IDEA",
      status: "OPEN",
    })

    await createFeedback({
      workspaceId: WS_ID,
      title: "  Dark mode support  ",
      description: "  Users want a dark mode option.  ",
      submitterName: "  Claude Code  ",
      submitterEmail: "  agent@example.com  ",
    })

    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        workspaceId: WS_ID,
        title: "Dark mode support",
        description: "Users want a dark mode option.",
        type: "IDEA",
        submitterName: "Claude Code",
        submitterEmail: "agent@example.com",
        source: "MCP",
      },
    })
  })

  it("returns error text and does not create when the workspace is not found", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(null)

    const result = await createFeedback({ workspaceId: WS_ID, title: "Dark mode support" })

    expect(result.content[0].text).toContain(`No workspace found with id "${WS_ID}"`)
    // failure path: ok=false, null data, and (for backward-compat) no isError flag
    expect(result.structuredContent.ok).toBe(false)
    expect(result.structuredContent.data).toBeNull()
    expect("isError" in result).toBe(false)
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
  })

  it("returns validation error text and does not create when title is blank", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)

    const result = await createFeedback({ workspaceId: WS_ID, title: "   " })

    expect(result.content[0].text).toContain("Title is required")
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
  })

  it("returns validation error text when title exceeds the max length", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)

    const result = await createFeedback({ workspaceId: WS_ID, title: "x".repeat(256) })

    expect(result.content[0].text).toContain("255 characters or fewer")
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
  })

  it("deletes uploaded blobs and returns no success when the database create fails", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    mockBlobPut.mockResolvedValueOnce({ url: "https://store.public.blob.vercel-storage.com/file.png" })
    mockFeedbackItem.create.mockRejectedValueOnce(new Error("database unavailable"))

    const result = await createFeedback({
      workspaceId: WS_ID,
      title: "Has a screenshot",
      attachments: [{ filename: "file.png", data: "data:image/png;base64,UE5H" }],
    })

    expect(result.structuredContent.ok).toBe(false)
    expect(result.content[0].text).toContain("database unavailable")
    expect(mockBlobDelete).toHaveBeenCalledWith(["https://store.public.blob.vercel-storage.com/file.png"])
  })
})

// ---------------------------------------------------------------------------
// getFeedbackItem
// ---------------------------------------------------------------------------

describe("getFeedbackItem", () => {
  it("returns all fields formatted as markdown when item is found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce(sampleItem)

    const result = await getFeedbackItem({ feedbackId: FEED_ID })

    expect(result.content).toHaveLength(1)
    const text = result.content[0].text
    expect(text).toContain("## [IDEA] Dark mode support")
    expect(text).toContain(`**ID:** ${FEED_ID}`)
    expect(text).toContain("**Type:** IDEA")
    expect(text).toContain("**Status:** OPEN")
    expect(text).toContain("**Votes:** 5")
    expect(text).toContain("**Submitter:** Alice")
    expect(text).toContain("**Email:** alice@example.com")
    expect(text).toContain("Users want a dark mode option.")
    expect(text).toContain("**Created:** 2025-01-01T00:00:00.000Z")
    expect(text).toContain(`URL: https://compass.rbcodelabs.com/rbcodelabs/compass/feedback?detail=feedback%3A${FEED_ID}`)
    expect(text).not.toContain("Attachments:")
    // get_* returns the entity object as structured data
    expect(result.structuredContent.ok).toBe(true)
    expect(result.structuredContent.data).toMatchObject({
      id: FEED_ID,
      status: "OPEN",
      voteCount: 5,
    })

    expect(mockFeedbackItem.findUnique).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      include: {
        opportunity: { select: { id: true, title: true, status: true } },
        attachments: { select: { filename: true, url: true } },
        workspace: { select: { slug: true, organization: { select: { slug: true } } } },
      },
    })
  })

  it("includes an Attachments line per attachment when attachments are present", async () => {
    const itemWithAttachments = {
      ...sampleItem,
      attachments: [
        { filename: "screenshot.png", url: "https://abc123.public.blob.vercel-storage.com/screenshot.png" },
        { filename: "notes.txt", url: "https://abc123.public.blob.vercel-storage.com/notes.txt" },
      ],
    }
    mockFeedbackItem.findUnique.mockResolvedValueOnce(itemWithAttachments)

    const result = await getFeedbackItem({ feedbackId: FEED_ID })
    const text = result.content[0].text

    expect(text).toContain("Attachments: screenshot.png (https://abc123.public.blob.vercel-storage.com/screenshot.png)")
    expect(text).toContain("Attachments: notes.txt (https://abc123.public.blob.vercel-storage.com/notes.txt)")
  })

  it("returns opportunity details when item is linked to an opportunity", async () => {
    const itemWithOpp = {
      ...sampleItem,
      opportunityId: OPP_ID,
      opportunity: { id: OPP_ID, title: "Improve visual accessibility", status: "EXPLORING" },
    }
    mockFeedbackItem.findUnique.mockResolvedValueOnce(itemWithOpp)

    const result = await getFeedbackItem({ feedbackId: FEED_ID })
    const text = result.content[0].text

    expect(text).toContain(`**Opportunity ID:** ${OPP_ID}`)
    expect(text).toContain("Improve visual accessibility")
    expect(text).toContain("EXPLORING")
  })

  it("returns error text when item is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce(null)

    const result = await getFeedbackItem({ feedbackId: FEED_ID })

    expect(result.content[0].text).toContain(`"${FEED_ID}" not found`)
  })
})

// ---------------------------------------------------------------------------
// updateFeedbackStatus
// ---------------------------------------------------------------------------

describe("updateFeedbackStatus", () => {
  it("returns old → new status and title on success", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      status: "OPEN",
      workspace: sampleItem.workspace,
    })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await updateFeedbackStatus({ feedbackId: FEED_ID, status: "UNDER_REVIEW" })
    const text = result.content[0].text

    expect(text).toContain("Dark mode support")
    expect(text).toContain("OPEN → UNDER_REVIEW")
    expect(text).toContain(`ID: ${FEED_ID}`)
    expect(text).toContain("URL: https://compass.rbcodelabs.com/")
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { status: "UNDER_REVIEW", updatedAt: expect.any(Date) },
    })
  })

  it("includes the note in the output when provided", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      status: "OPEN",
      workspace: sampleItem.workspace,
    })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await updateFeedbackStatus({
      feedbackId: FEED_ID,
      status: "PLANNED",
      note: "Linked to Q3 roadmap",
    })
    const text = result.content[0].text

    expect(text).toContain("Note: Linked to Q3 roadmap")
  })

  it("writes legacy CLOSED unchanged while compatibility support remains", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      status: "DECLINED",
      workspace: sampleItem.workspace,
    })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    await updateFeedbackStatus({ feedbackId: FEED_ID, status: "CLOSED" })

    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { status: "CLOSED", updatedAt: expect.any(Date) },
    })
  })

  it("returns error text when item is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce(null)

    const result = await updateFeedbackStatus({ feedbackId: FEED_ID, status: "CLOSED" })

    expect(result.content[0].text).toContain(`"${FEED_ID}" not found`)
    expect(mockFeedbackItem.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// linkFeedbackToOpportunity
// ---------------------------------------------------------------------------

describe("linkFeedbackToOpportunity", () => {
  it("links feedback to opportunity and returns confirmation message", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      workspaceId: WS_ID,
      workspace: sampleItem.workspace,
    })
    mockOpportunity.findUnique.mockResolvedValueOnce(sampleOpportunity)
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await linkFeedbackToOpportunity({ feedbackId: FEED_ID, opportunityId: OPP_ID })
    const text = result.content[0].text

    expect(text).toContain("Linked feedback 'Dark mode support'")
    expect(text).toContain("'Improve visual accessibility'")
    expect(text).toContain(`ID: ${FEED_ID}`)
    expect(text).toContain("URL: https://compass.rbcodelabs.com/")
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { opportunityId: OPP_ID, updatedAt: expect.any(Date) },
    })
  })

  it("returns error text when feedback item is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce(null)

    const result = await linkFeedbackToOpportunity({ feedbackId: FEED_ID, opportunityId: OPP_ID })

    expect(result.content[0].text).toContain(`"${FEED_ID}" not found`)
    expect(mockOpportunity.findUnique).not.toHaveBeenCalled()
    expect(mockFeedbackItem.update).not.toHaveBeenCalled()
  })

  it("returns error text when opportunity is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Dark mode support",
      workspaceId: WS_ID,
      workspace: sampleItem.workspace,
    })
    mockOpportunity.findUnique.mockResolvedValueOnce(null)

    const result = await linkFeedbackToOpportunity({ feedbackId: FEED_ID, opportunityId: OPP_ID })

    expect(result.content[0].text).toContain(`"${OPP_ID}" not found`)
    expect(mockFeedbackItem.update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// updateFeedbackType
// ---------------------------------------------------------------------------

describe("updateFeedbackType", () => {
  it("returns old → new type and title on success, with an ID line", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Login button broken",
      type: "IDEA",
      workspace: sampleItem.workspace,
    })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await updateFeedbackType({ feedbackId: FEED_ID, type: "BUG" })
    const text = result.content[0].text

    expect(text).toContain("Login button broken")
    expect(text).toContain("IDEA → BUG")
    expect(text).toContain(`ID: ${FEED_ID}`)
    expect(text).toContain("URL: https://compass.rbcodelabs.com/")
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { type: "BUG", updatedAt: expect.any(Date) },
    })
  })

  it("returns error text when item is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce(null)

    const result = await updateFeedbackType({ feedbackId: FEED_ID, type: "BUG" })

    expect(result.content[0].text).toContain(`"${FEED_ID}" not found`)
    expect(mockFeedbackItem.update).not.toHaveBeenCalled()
  })
})

describe("updateFeedback", () => {
  it("updates supplied text fields, permits clearing description, and returns ID plus canonical URL", async () => {
    expect(feedbackHandlers.updateFeedback).toBeTypeOf("function")
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Old title",
      description: "Old description",
      workspace: sampleItem.workspace,
    })
    mockFeedbackItem.update.mockResolvedValueOnce({
      id: FEED_ID,
      title: "Better title",
      description: null,
    })

    const result = await feedbackHandlers.updateFeedback({
      feedbackId: FEED_ID,
      title: " Better title ",
      description: null,
    })

    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { title: "Better title", description: null, updatedAt: expect.any(Date) },
      select: { id: true, title: true, description: true },
    })
    expect(result.content[0].text).toContain(`ID: ${FEED_ID}`)
    expect(result.content[0].text).toContain("URL: https://compass.rbcodelabs.com/")
  })

  it("rejects a call with neither title nor description", async () => {
    expect(feedbackHandlers.updateFeedback).toBeTypeOf("function")
    const result = await feedbackHandlers.updateFeedback({ feedbackId: FEED_ID })
    expect(result.content[0].text).toContain("Provide title and/or description")
    expect(mockFeedbackItem.findUnique).not.toHaveBeenCalled()
  })
})

describe("listFeedback", () => {
  it("returns a canonical URL for every item", async () => {
    expect(feedbackHandlers.listFeedback).toBeTypeOf("function")
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    mockFeedbackItem.findMany.mockResolvedValueOnce([sampleItem])

    const result = await feedbackHandlers.listFeedback({ workspaceId: WS_ID, limit: 50 })

    expect(result.content[0].text).toContain(`URL: https://compass.rbcodelabs.com/rbcodelabs/compass/feedback?detail=feedback%3A${FEED_ID}`)
    const data = result.structuredContent.data as { items: Array<{ url: string }> }
    expect(data.items[0].url).toContain(`feedback%3A${FEED_ID}`)
  })
})

describe("addFeedbackAttachment", () => {
  it("attaches an inline screenshot and returns attachment ID plus feedback URL", async () => {
    expect(feedbackHandlers.addFeedbackAttachment).toBeTypeOf("function")
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      workspaceId: WS_ID,
      workspace: sampleItem.workspace,
    })
    mockBlobPut.mockResolvedValueOnce({ url: "https://store.public.blob.vercel-storage.com/file.png" })
    mockFeedbackAttachment.findFirst.mockResolvedValueOnce(null)
    mockFeedbackAttachment.create.mockResolvedValueOnce({
      id: "attachment-1",
      feedbackItemId: FEED_ID,
      url: "https://store.public.blob.vercel-storage.com/file.png",
      filename: "file.png",
      fileType: "image/png",
      fileSize: 3,
    })

    const result = await feedbackHandlers.addFeedbackAttachment({
      feedbackId: FEED_ID,
      inline: { filename: "file.png", data: "data:image/png;base64,UE5H" },
    })

    expect(result.content[0].text).toContain("ID: attachment-1")
    expect(result.content[0].text).toContain(`feedback%3A${FEED_ID}`)
  })

  it("rejects a bogus direct receipt before checking for a prior attachment", async () => {
    expect(feedbackHandlers.addFeedbackAttachment).toBeTypeOf("function")
    mockFeedbackItem.findUnique.mockResolvedValue({
      id: FEED_ID,
      workspaceId: WS_ID,
      workspace: sampleItem.workspace,
    })
    const existing = {
      id: "attachment-1",
      feedbackItemId: FEED_ID,
      url: "https://store.public.blob.vercel-storage.com/file.png",
      filename: "file.png",
      fileType: "image/png",
      fileSize: 3,
    }
    mockFeedbackAttachment.findFirst.mockResolvedValueOnce(existing)

    const result = await feedbackHandlers.addFeedbackAttachment({
      feedbackId: FEED_ID,
      uploaded: { url: existing.url, receipt: "receipt" },
    })
    expect(result.content[0].text).toContain("Invalid upload receipt")
    expect(mockBlobHead).not.toHaveBeenCalled()
    expect(mockFeedbackAttachment.create).not.toHaveBeenCalled()
  })

  it("rejects an expired direct receipt before checking for a prior attachment", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-30T12:00:00Z"))
    mockGenerateClientToken.mockResolvedValueOnce("client-token")
    const prepared = await prepareFeedbackAttachmentUpload({ workspaceId: WS_ID, filename: "old.png", fileType: "image/png", fileSize: 3 })
    vi.advanceTimersByTime(11 * 60 * 1000)
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, workspaceId: WS_ID, workspace: sampleItem.workspace })
    const result = await feedbackHandlers.addFeedbackAttachment({
      feedbackId: FEED_ID,
      uploaded: { url: "https://test.public.blob.vercel-storage.com/old.png", receipt: prepared.receipt },
    })
    expect(result.content[0].text).toMatch(/expired/)
    expect(mockBlobHead).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it("verifies a prepared direct upload against Blob metadata before attaching it", async () => {
    mockGenerateClientToken.mockResolvedValueOnce("client-token")
    const prepared = await prepareFeedbackAttachmentUpload({
      workspaceId: WS_ID,
      filename: "file.png",
      fileType: "image/png",
      fileSize: 3,
    })
    const url = "https://test.public.blob.vercel-storage.com/file.png"
    mockFeedbackItem.findUnique.mockResolvedValueOnce({
      id: FEED_ID,
      workspaceId: WS_ID,
      workspace: sampleItem.workspace,
    })
    mockFeedbackAttachment.findFirst.mockResolvedValueOnce(null)
    mockBlobHead.mockResolvedValueOnce({
      url,
      pathname: prepared.pathname,
      contentType: "image/png",
      size: 3,
    })
    mockFeedbackAttachment.create.mockResolvedValueOnce({
      id: "attachment-1",
      feedbackItemId: FEED_ID,
      url,
      filename: "file.png",
      fileType: "image/png",
      fileSize: 3,
    })

    const result = await feedbackHandlers.addFeedbackAttachment({
      feedbackId: FEED_ID,
      uploaded: { url, receipt: prepared.receipt },
    })

    expect(mockBlobHead).toHaveBeenCalledWith(url)
    expect(mockFeedbackAttachment.create).toHaveBeenCalledWith({
      data: {
        id: prepared.attachmentId,
        feedbackItemId: FEED_ID,
        url,
        filename: "file.png",
        fileType: "image/png",
        fileSize: 3,
      },
    })
    expect(result.content[0].text).toContain("ID: attachment-1")
  })
})

describe("feedback mutation safety", () => {
  it("validates the canonical origin before create uploads or writes", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://evil.example.com"
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    await expect(createFeedback({
      workspaceId: WS_ID,
      title: "Screenshot issue",
      attachments: [{ filename: "shot.png", data: "data:image/png;base64,UE5H" }],
    })).rejects.toThrow(/HTTPS/)
    expect(mockBlobPut).not.toHaveBeenCalled()
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
  })

  it.each([
    ["update", () => feedbackHandlers.updateFeedback({ feedbackId: FEED_ID, title: "New" })],
    ["status", () => updateFeedbackStatus({ feedbackId: FEED_ID, status: "UNDER_REVIEW" })],
    ["link", () => linkFeedbackToOpportunity({ feedbackId: FEED_ID, opportunityId: OPP_ID })],
    ["type", () => updateFeedbackType({ feedbackId: FEED_ID, type: "BUG" })],
    ["attachment", () => feedbackHandlers.addFeedbackAttachment({
      feedbackId: FEED_ID,
      inline: { filename: "shot.png", data: "data:image/png;base64,UE5H" },
    })],
  ])("validates the canonical origin before the %s mutation", async (_name, invoke) => {
    process.env.NEXT_PUBLIC_APP_URL = "http://evil.example.com"
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ ...sampleItem, workspace: sampleItem.workspace })
    await expect(invoke()).rejects.toThrow(/HTTPS/)
    expect(mockFeedbackItem.update).not.toHaveBeenCalled()
    expect(mockFeedbackAttachment.create).not.toHaveBeenCalled()
    expect(mockBlobPut).not.toHaveBeenCalled()
  })

  it("allows the fifth attachment but rejects a sixth before inline upload", async () => {
    mockFeedbackItem.findUnique.mockResolvedValue({ id: FEED_ID, workspaceId: WS_ID, workspace: sampleItem.workspace })
    mockFeedbackAttachment.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4)
    mockBlobPut.mockResolvedValueOnce({ url: "https://store.public.blob.vercel-storage.com/fifth.png" })
    mockFeedbackAttachment.create.mockResolvedValueOnce({
      id: "55555555-5555-4555-8555-555555555555", feedbackItemId: FEED_ID,
      url: "https://store.public.blob.vercel-storage.com/fifth.png", filename: "fifth.png", fileType: "image/png", fileSize: 3,
    })
    const fifth = await feedbackHandlers.addFeedbackAttachment({ feedbackId: FEED_ID, inline: { filename: "fifth.png", data: "data:image/png;base64,UE5H" } })
    expect(fifth.structuredContent.ok).toBe(true)

    mockFeedbackAttachment.count.mockResolvedValueOnce(5)
    const sixth = await feedbackHandlers.addFeedbackAttachment({ feedbackId: FEED_ID, inline: { filename: "sixth.png", data: "data:image/png;base64,UE5H" } })
    expect(sixth.content[0].text).toMatch(/maximum of 5/)
    expect(mockBlobPut).toHaveBeenCalledTimes(1)
  })

  it("recovers a create_feedback success after an ambiguous post-commit error without deleting its Blob", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(workspaceContext)
    mockBlobPut.mockResolvedValueOnce({ url: "https://store.public.blob.vercel-storage.com/shot.png" })
    mockFeedbackItem.create.mockRejectedValueOnce(new Error("connection lost after commit"))
    mockFeedbackItem.findUnique.mockImplementationOnce(async ({ where }: { where: { id: string } }) => ({
      ...sampleItem, id: where.id, title: "Screenshot issue", status: "OPEN", type: "IDEA",
    }))
    const result = await createFeedback({
      workspaceId: WS_ID, title: "Screenshot issue",
      attachments: [{ filename: "shot.png", data: "data:image/png;base64,UE5H" }],
    })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockBlobDelete).not.toHaveBeenCalled()
  })

  it("deletes an inline Blob only after confirming add attachment did not commit", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, workspaceId: WS_ID, workspace: sampleItem.workspace })
    mockFeedbackAttachment.count.mockResolvedValue(4)
    mockBlobPut.mockResolvedValueOnce({ url: "https://store.public.blob.vercel-storage.com/orphan.png" })
    mockFeedbackAttachment.create.mockRejectedValueOnce(new Error("database unavailable"))
    mockFeedbackAttachment.findUnique.mockResolvedValueOnce(null)
    const result = await feedbackHandlers.addFeedbackAttachment({
      feedbackId: FEED_ID, inline: { filename: "orphan.png", data: "data:image/png;base64,UE5H" },
    })
    expect(result.content[0].text).toContain("database unavailable")
    expect(mockBlobDelete).toHaveBeenCalledWith(["https://store.public.blob.vercel-storage.com/orphan.png"])
  })

  it("treats concurrent completion of one direct receipt as one create plus idempotent success", async () => {
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await prepareFeedbackAttachmentUpload({ workspaceId: WS_ID, filename: "same.png", fileType: "image/png", fileSize: 3 })
    const url = "https://test.public.blob.vercel-storage.com/same.png"
    mockFeedbackItem.findUnique.mockResolvedValue({ id: FEED_ID, workspaceId: WS_ID, workspace: sampleItem.workspace })
    mockFeedbackAttachment.count.mockResolvedValue(0)
    mockBlobHead.mockResolvedValue({ url, pathname: prepared.pathname, contentType: "image/png", size: 3 })
    const winner = { id: prepared.attachmentId, feedbackItemId: FEED_ID, url, filename: "same.png", fileType: "image/png", fileSize: 3 }
    mockFeedbackAttachment.create.mockResolvedValueOnce(winner).mockRejectedValueOnce(new Error("duplicate key"))
    mockFeedbackAttachment.findUnique.mockResolvedValueOnce(winner)
    const [first, second] = await Promise.all([
      feedbackHandlers.addFeedbackAttachment({ feedbackId: FEED_ID, uploaded: { url, receipt: prepared.receipt } }),
      feedbackHandlers.addFeedbackAttachment({ feedbackId: FEED_ID, uploaded: { url, receipt: prepared.receipt } }),
    ])
    expect([first, second].every((result) => result.structuredContent.ok)).toBe(true)
    expect(mockFeedbackAttachment.create).toHaveBeenCalledTimes(2)
    expect(mockBlobDelete).not.toHaveBeenCalled()
  })

  it("preserves a shared direct-upload Blob when preflight loses a DSQL OCC race before the winner is visible", async () => {
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await prepareFeedbackAttachmentUpload({ workspaceId: WS_ID, filename: "shared.png", fileType: "image/png", fileSize: 3 })
    const url = "https://test.public.blob.vercel-storage.com/shared.png"
    mockFeedbackItem.findUnique.mockResolvedValue({ id: FEED_ID, workspaceId: WS_ID, workspace: sampleItem.workspace })
    mockBlobHead.mockResolvedValue({ url, pathname: prepared.pathname, contentType: "image/png", size: 3 })
    mockPrisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("change conflicts with another transaction (OC000)"), { code: "40001" }))
    mockFeedbackAttachment.findUnique.mockResolvedValueOnce(null)

    const result = await feedbackHandlers.addFeedbackAttachment({ feedbackId: FEED_ID, uploaded: { url, receipt: prepared.receipt } })

    expect(result.content[0].text).toMatch(/retry/i)
    expect(mockFeedbackAttachment.findUnique).toHaveBeenCalledWith({ where: { id: prepared.attachmentId } })
    expect(mockBlobDelete).not.toHaveBeenCalled()
  })

  it.each([
    [FEED_ID, true, "already attached"],
    [OPP_ID, false, "already belongs to another feedback item"],
  ])("respects a portal or legacy row with the same verified URL (owner %s)", async (ownerId, succeeds, message) => {
    mockGenerateClientToken.mockResolvedValue("client-token")
    const prepared = await prepareFeedbackAttachmentUpload({ workspaceId: WS_ID, filename: "legacy.png", fileType: "image/png", fileSize: 3 })
    const url = "https://test.public.blob.vercel-storage.com/legacy.png"
    mockFeedbackItem.findUnique.mockResolvedValue({ id: FEED_ID, workspaceId: WS_ID, workspace: sampleItem.workspace })
    mockFeedbackAttachment.count.mockResolvedValue(0)
    mockBlobHead.mockResolvedValue({ url, pathname: prepared.pathname, contentType: "image/png", size: 3 })
    mockFeedbackAttachment.findFirst.mockResolvedValueOnce({
      id: "legacy-attachment", feedbackItemId: ownerId, url, filename: "legacy.png", fileType: "image/png", fileSize: 3,
    })
    const result = await feedbackHandlers.addFeedbackAttachment({ feedbackId: FEED_ID, uploaded: { url, receipt: prepared.receipt } })
    expect(result.structuredContent.ok).toBe(succeeds)
    expect(result.content[0].text).toContain(message)
    expect(mockFeedbackAttachment.create).not.toHaveBeenCalled()
    expect(mockBlobDelete).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// promoteFeedbackToRoadmap
// ---------------------------------------------------------------------------

describe("promoteFeedbackToRoadmap", () => {
  it("creates a roadmap item from the feedback title and returns an ID line", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, title: "Login button broken", type: "BUG" })
    mockRoadmapItem.findFirst.mockResolvedValueOnce(null)
    mockRoadmapItem.create.mockResolvedValueOnce({ id: "item-1", title: "Login button broken" })

    const result = await promoteFeedbackToRoadmap({ feedbackId: FEED_ID, workspaceId: WS_ID, horizon: "NEXT" })
    const text = result.content[0].text

    expect(text).toContain("Promoted to roadmap (NEXT)")
    expect(text).toContain("ID: item-1")
    expect(text).toContain("Login button broken")
    expect(mockRoadmapItem.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WS_ID,
        title: "Login button broken",
        horizon: "NEXT",
        sortOrder: 0,
        feedbackId: FEED_ID,
        isPrivate: false,
      },
    })
  })

  it("places item after the last item in the horizon", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, title: "Crash on save", type: "BUG" })
    mockRoadmapItem.findFirst.mockResolvedValueOnce({ sortOrder: 4 })
    mockRoadmapItem.create.mockResolvedValueOnce({ id: "item-2", title: "Crash on save" })

    await promoteFeedbackToRoadmap({ feedbackId: FEED_ID, workspaceId: WS_ID, horizon: "NEXT" })

    expect(mockRoadmapItem.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WS_ID,
        title: "Crash on save",
        horizon: "NEXT",
        sortOrder: 5,
        feedbackId: FEED_ID,
        isPrivate: false,
      },
    })
  })

  it("returns error text when feedback item is not found", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce(null)

    const result = await promoteFeedbackToRoadmap({ feedbackId: FEED_ID, workspaceId: WS_ID, horizon: "NEXT" })

    expect(result.content[0].text).toContain(`"${FEED_ID}" not found`)
    expect(mockRoadmapItem.create).not.toHaveBeenCalled()
  })

  it("passes through isPrivate: true (e.g. a security-flagged bug) and surfaces it in the response text", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, title: "Auth bypass", type: "BUG" })
    mockRoadmapItem.findFirst.mockResolvedValueOnce(null)
    mockRoadmapItem.create.mockResolvedValueOnce({ id: "item-3", title: "Auth bypass", isPrivate: true })

    const result = await promoteFeedbackToRoadmap({
      feedbackId: FEED_ID,
      workspaceId: WS_ID,
      horizon: "NEXT",
      isPrivate: true,
    })

    const data = mockRoadmapItem.create.mock.calls[0][0].data
    expect(data.isPrivate).toBe(true)
    expect(result.content[0].text).toContain("Private: yes")
  })
})
