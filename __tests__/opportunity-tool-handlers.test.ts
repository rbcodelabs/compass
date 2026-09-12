import { beforeEach, describe, expect, it, vi } from "vitest"

const mockOpportunity = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

vi.mock("@/lib/db", () => ({
  default: () => ({ opportunity: mockOpportunity }),
}))

import { updateOpportunity } from "@/lib/opportunity-tool-handlers"

const OPPORTUNITY_ID = "e1b57392-d269-4fa7-bca1-140a815cbb92"

function textOf(result: { content: Array<{ text: string }> }) {
  return result.content[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  mockOpportunity.findUnique.mockResolvedValue({
    id: OPPORTUNITY_ID,
    title: "Customers cannot refine opportunities",
    description: "The MCP only supports status changes.",
    status: "EXPLORING",
  })
  mockOpportunity.update.mockImplementation(({ data }) =>
    Promise.resolve({
      id: OPPORTUNITY_ID,
      title: "Customers cannot refine opportunities",
      description: "The MCP only supports status changes.",
      status: "EXPLORING",
      ...data,
    }),
  )
})

describe("updateOpportunity", () => {
  it("rejects an invalid opportunity ID before reading or writing", async () => {
    const result = await updateOpportunity({ opportunityId: "not-a-uuid", title: "New title" })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toMatch(/valid opportunity id/i)
    expect(mockOpportunity.findUnique).not.toHaveBeenCalled()
    expect(mockOpportunity.update).not.toHaveBeenCalled()
  })

  it("updates title and description, trims them, sets updatedAt, and returns the updated metadata", async () => {
    const result = await updateOpportunity({
      opportunityId: OPPORTUNITY_ID,
      title: "  Agents cannot refine opportunity metadata  ",
      description: "  Title and description updates are unavailable.  ",
    })

    expect(mockOpportunity.findUnique).toHaveBeenCalledWith({
      where: { id: OPPORTUNITY_ID },
      select: { id: true, title: true, description: true, status: true, customerSegment: true, updatedAt: true },
    })
    const data = mockOpportunity.update.mock.calls[0][0].data
    expect(data).toMatchObject({
      title: "Agents cannot refine opportunity metadata",
      description: "Title and description updates are unavailable.",
    })
    expect(data.updatedAt).toBeInstanceOf(Date)
    expect(data).not.toHaveProperty("status")
    expect(result.structuredContent.data).toMatchObject({
      id: OPPORTUNITY_ID,
      title: "Agents cannot refine opportunity metadata",
      description: "Title and description updates are unavailable.",
      status: "EXPLORING",
    })
    expect(textOf(result)).toContain(`\nID: ${OPPORTUNITY_ID}\n`)
  })

  it("updates only title when description is omitted", async () => {
    await updateOpportunity({ opportunityId: OPPORTUNITY_ID, title: "  New title  " })

    const data = mockOpportunity.update.mock.calls[0][0].data
    expect(data.title).toBe("New title")
    expect(data).not.toHaveProperty("description")
  })

  it("updates only description when title is omitted", async () => {
    await updateOpportunity({ opportunityId: OPPORTUNITY_ID, description: "  New detail  " })

    const data = mockOpportunity.update.mock.calls[0][0].data
    expect(data.description).toBe("New detail")
    expect(data).not.toHaveProperty("title")
  })

  it("clears description when it is explicitly null", async () => {
    await updateOpportunity({ opportunityId: OPPORTUNITY_ID, description: null })

    expect(mockOpportunity.update.mock.calls[0][0].data.description).toBeNull()
  })

  it.each([
    [{ title: "" }, /title.*empty/i],
    [{ title: "   " }, /title.*empty/i],
    [{ title: "x".repeat(256) }, /title.*255/i],
    [{ description: "" }, /description.*empty/i],
    [{ description: "   " }, /description.*empty/i],
  ])("rejects invalid editable metadata %#", async (fields, message) => {
    const result = await updateOpportunity({ opportunityId: OPPORTUNITY_ID, ...fields })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toMatch(message)
    expect(mockOpportunity.findUnique).not.toHaveBeenCalled()
    expect(mockOpportunity.update).not.toHaveBeenCalled()
  })

  it("rejects calls with no editable fields", async () => {
    const result = await updateOpportunity({ opportunityId: OPPORTUNITY_ID })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toMatch(/title or description/i)
    expect(mockOpportunity.findUnique).not.toHaveBeenCalled()
    expect(mockOpportunity.update).not.toHaveBeenCalled()
  })

  it("rejects a normalized no-op without writing", async () => {
    const result = await updateOpportunity({
      opportunityId: OPPORTUNITY_ID,
      title: "  Customers cannot refine opportunities  ",
      description: " The MCP only supports status changes. ",
    })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toMatch(/no editable changes/i)
    expect(mockOpportunity.update).not.toHaveBeenCalled()
  })

  it("returns not found without writing when the opportunity does not exist", async () => {
    mockOpportunity.findUnique.mockResolvedValueOnce(null)

    const result = await updateOpportunity({ opportunityId: OPPORTUNITY_ID, title: "New title" })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toMatch(/not found/i)
    expect(mockOpportunity.update).not.toHaveBeenCalled()
  })
})
