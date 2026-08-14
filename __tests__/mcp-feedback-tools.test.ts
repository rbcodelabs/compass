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

const mockPrisma = {
  feedbackItem: mockFeedbackItem,
  opportunity: mockOpportunity,
  roadmapItem: mockRoadmapItem,
  workspace: mockWorkspace,
}

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

// ---------------------------------------------------------------------------

const FEED_ID = "11111111-1111-1111-1111-111111111111"
const OPP_ID = "22222222-2222-2222-2222-222222222222"
const WS_ID = "33333333-3333-3333-3333-333333333333"

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
}

const sampleOpportunity = {
  id: OPP_ID,
  title: "Improve visual accessibility",
  status: "EXPLORING",
  workspaceId: WS_ID,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// createFeedback
// ---------------------------------------------------------------------------

describe("createFeedback", () => {
  it("creates a feedback item with source MCP and defaults type to IDEA", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })
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
    expect(mockFeedbackItem.create).toHaveBeenCalledWith({
      data: {
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
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })
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
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })
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
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
  })

  it("returns validation error text and does not create when title is blank", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })

    const result = await createFeedback({ workspaceId: WS_ID, title: "   " })

    expect(result.content[0].text).toContain("Title is required")
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
  })

  it("returns validation error text when title exceeds the max length", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce({ id: WS_ID })

    const result = await createFeedback({ workspaceId: WS_ID, title: "x".repeat(256) })

    expect(result.content[0].text).toContain("255 characters or fewer")
    expect(mockFeedbackItem.create).not.toHaveBeenCalled()
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
    expect(text).not.toContain("Attachments:")

    expect(mockFeedbackItem.findUnique).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      include: {
        opportunity: { select: { id: true, title: true, status: true } },
        attachments: { select: { filename: true, url: true } },
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
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ title: "Dark mode support", status: "OPEN" })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await updateFeedbackStatus({ feedbackId: FEED_ID, status: "UNDER_REVIEW" })
    const text = result.content[0].text

    expect(text).toContain("Dark mode support")
    expect(text).toContain("OPEN → UNDER_REVIEW")
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { status: "UNDER_REVIEW", updatedAt: expect.any(Date) },
    })
  })

  it("includes the note in the output when provided", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ title: "Dark mode support", status: "OPEN" })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await updateFeedbackStatus({
      feedbackId: FEED_ID,
      status: "PLANNED",
      note: "Linked to Q3 roadmap",
    })
    const text = result.content[0].text

    expect(text).toContain("Note: Linked to Q3 roadmap")
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
    })
    mockOpportunity.findUnique.mockResolvedValueOnce(sampleOpportunity)
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await linkFeedbackToOpportunity({ feedbackId: FEED_ID, opportunityId: OPP_ID })
    const text = result.content[0].text

    expect(text).toContain("Linked feedback 'Dark mode support'")
    expect(text).toContain("'Improve visual accessibility'")
    expect(mockFeedbackItem.update).toHaveBeenCalledWith({
      where: { id: FEED_ID },
      data: { opportunityId: OPP_ID },
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
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, title: "Login button broken", type: "IDEA" })
    mockFeedbackItem.update.mockResolvedValueOnce({})

    const result = await updateFeedbackType({ feedbackId: FEED_ID, type: "BUG" })
    const text = result.content[0].text

    expect(text).toContain("Login button broken")
    expect(text).toContain("IDEA → BUG")
    expect(text).toContain(`ID: ${FEED_ID}`)
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

// ---------------------------------------------------------------------------
// promoteFeedbackToRoadmap
// ---------------------------------------------------------------------------

describe("promoteFeedbackToRoadmap", () => {
  it("creates a roadmap item from the feedback title and returns an ID line", async () => {
    mockFeedbackItem.findUnique.mockResolvedValueOnce({ id: FEED_ID, title: "Login button broken", type: "BUG" })
    mockRoadmapItem.findFirst.mockResolvedValueOnce(null)
    mockRoadmapItem.create.mockResolvedValueOnce({ id: "item-1", title: "Login button broken" })

    const result = await promoteFeedbackToRoadmap({ feedbackId: FEED_ID, workspaceId: WS_ID, horizon: "NOW" })
    const text = result.content[0].text

    expect(text).toContain("Promoted to roadmap (NOW)")
    expect(text).toContain("ID: item-1")
    expect(text).toContain("Login button broken")
    expect(mockRoadmapItem.create).toHaveBeenCalledWith({
      data: {
        workspaceId: WS_ID,
        title: "Login button broken",
        horizon: "NOW",
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

    const result = await promoteFeedbackToRoadmap({ feedbackId: FEED_ID, workspaceId: WS_ID, horizon: "NOW" })

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
      horizon: "NOW",
      isPrivate: true,
    })

    const data = mockRoadmapItem.create.mock.calls[0][0].data
    expect(data.isPrivate).toBe(true)
    expect(result.content[0].text).toContain("Private: yes")
  })
})
