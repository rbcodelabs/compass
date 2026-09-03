/**
 * Unit tests for the Launch Tiers + Checklist Templates MCP tool handlers
 * (create_checklist_template, list_checklist_templates, set_launch_tier,
 * get_launch_checklist, update_launch_checklist_item).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------

const mockWorkspace = {
  findUnique: vi.fn(),
}

const mockRoadmapItem = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

const mockChecklistTemplate = {
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
}

const mockChecklistTemplateItem = {
  createMany: vi.fn(),
}

const mockLaunchChecklist = {
  create: vi.fn(),
  findUnique: vi.fn(),
}

const mockLaunchChecklistItem = {
  createMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}

const mockPrisma = {
  workspace: mockWorkspace,
  roadmapItem: mockRoadmapItem,
  checklistTemplate: mockChecklistTemplate,
  checklistTemplateItem: mockChecklistTemplateItem,
  launchChecklist: mockLaunchChecklist,
  launchChecklistItem: mockLaunchChecklistItem,
  portfolioCapacityReservation: { findUnique: vi.fn(), update: vi.fn() },
  portfolioCapacityPlan: { updateMany: vi.fn() },
  // Array-form $transaction: just resolves each promise in sequence, like the
  // real Prisma client does when given an array (not the interactive-callback form).
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import {
  createChecklistTemplate,
  listChecklistTemplates,
  setLaunchTier,
  getLaunchChecklist,
  updateLaunchChecklistItem,
} from "@/lib/roadmap-tool-handlers"

// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1"
const ITEM_ID = "item-1"
const TEMPLATE_ID = "template-1"
const CHECKLIST_ID = "checklist-1"
const CHECKLIST_ITEM_ID = "checklist-item-1"

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

const templateWithItems = {
  id: TEMPLATE_ID,
  workspaceId: WORKSPACE_ID,
  tier: "TIER_1",
  name: "Major Launch Checklist",
  description: null,
  status: "ACTIVE",
  items: [
    { id: "ti-1", checklistTemplateId: TEMPLATE_ID, label: "Write launch announcement", description: null, order: 0 },
    { id: "ti-2", checklistTemplateId: TEMPLATE_ID, label: "Brief support team", description: null, order: 1 },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPrisma.$transaction.mockImplementation((operation: Promise<unknown>[] | ((database: typeof mockPrisma) => unknown)) => Array.isArray(operation) ? Promise.all(operation) : operation(mockPrisma))
  mockPrisma.portfolioCapacityReservation.findUnique.mockResolvedValue(null)

  mockWorkspace.findUnique.mockResolvedValue({ id: WORKSPACE_ID })
  mockRoadmapItem.findUnique.mockResolvedValue({
    id: ITEM_ID,
    title: "Ship payments",
    workspaceId: WORKSPACE_ID,
    horizon: "NOW",
  })
  mockRoadmapItem.update.mockResolvedValue({ id: ITEM_ID, horizon: "LAUNCHING" })

  mockChecklistTemplate.create.mockResolvedValue({ id: TEMPLATE_ID, name: "Major Launch Checklist" })
  mockChecklistTemplate.findUnique.mockResolvedValue(templateWithItems)
  mockChecklistTemplate.findFirst.mockResolvedValue(templateWithItems)
  mockChecklistTemplate.findMany.mockResolvedValue([templateWithItems])

  mockChecklistTemplateItem.createMany.mockResolvedValue({ count: 2 })

  mockLaunchChecklist.create.mockResolvedValue({ id: CHECKLIST_ID })
  mockLaunchChecklist.findUnique.mockResolvedValue({
    id: CHECKLIST_ID,
    roadmapItemId: ITEM_ID,
    tier: "TIER_1",
    items: [
      { id: "lci-1", label: "Write launch announcement", description: null, status: "PENDING", order: 0 },
      { id: "lci-2", label: "Brief support team", description: null, status: "DONE", order: 1 },
    ],
  })

  mockLaunchChecklistItem.createMany.mockResolvedValue({ count: 2 })
  mockLaunchChecklistItem.findUnique.mockResolvedValue({ id: CHECKLIST_ITEM_ID, label: "Brief support team" })
  mockLaunchChecklistItem.update.mockImplementation(({ data }) =>
    Promise.resolve({ id: CHECKLIST_ITEM_ID, label: "Brief support team", status: "PENDING", ...data })
  )
})

// ---------------------------------------------------------------------------

describe("createChecklistTemplate", () => {
  it("returns a not-found message when the workspace does not exist", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(null)

    const result = await createChecklistTemplate({
      workspaceId: "missing-ws",
      tier: "TIER_1",
      name: "Test",
      items: [],
    })

    expect(textOf(result)).toContain("not found")
    expect(mockChecklistTemplate.create).not.toHaveBeenCalled()
  })

  it("creates the template and its items, then returns a bare ID line", async () => {
    const result = await createChecklistTemplate({
      workspaceId: WORKSPACE_ID,
      tier: "TIER_1",
      name: "Major Launch Checklist",
      items: [{ label: "Write launch announcement" }, { label: "Brief support team" }],
    })

    expect(mockChecklistTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: WORKSPACE_ID, tier: "TIER_1", name: "Major Launch Checklist" }),
    })
    expect(mockChecklistTemplateItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ checklistTemplateId: TEMPLATE_ID, label: "Write launch announcement", order: 0 }),
        expect.objectContaining({ checklistTemplateId: TEMPLATE_ID, label: "Brief support team", order: 1 }),
      ],
    })

    const text = textOf(result)
    expect(text).toContain(`ID: ${TEMPLATE_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("skips createMany when no items are provided", async () => {
    await createChecklistTemplate({ workspaceId: WORKSPACE_ID, tier: "TIER_3", name: "Silent", items: [] })
    expect(mockChecklistTemplateItem.createMany).not.toHaveBeenCalled()
  })
})

describe("listChecklistTemplates", () => {
  it("returns a not-found message when the workspace does not exist", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(null)

    const result = await listChecklistTemplates({ workspaceId: "missing-ws" })

    expect(textOf(result)).toContain("not found")
  })

  it("lists templates including their bare ID lines", async () => {
    const result = await listChecklistTemplates({ workspaceId: WORKSPACE_ID })

    const text = textOf(result)
    expect(text).toContain("Major Launch Checklist")
    expect(text).toContain(`ID: ${TEMPLATE_ID}`)
  })

  it("filters by tier when provided", async () => {
    await listChecklistTemplates({ workspaceId: WORKSPACE_ID, tier: "TIER_2" })

    expect(mockChecklistTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tier: "TIER_2" }) })
    )
  })
})

describe("setLaunchTier", () => {
  it("returns a not-found message when the roadmap item does not exist", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce(null)

    const result = await setLaunchTier({ itemId: "missing-item", tier: "TIER_1" })

    expect(textOf(result)).toContain("not found")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("rejects an item that is already LAUNCHING, without writing", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce({
      id: ITEM_ID, title: "Ship payments", workspaceId: WORKSPACE_ID, horizon: "LAUNCHING",
    })

    const result = await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1" })

    expect(textOf(result)).toContain("already LAUNCHING")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("rejects an item that is already LAUNCHED, without writing", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce({
      id: ITEM_ID, title: "Ship payments", workspaceId: WORKSPACE_ID, horizon: "LAUNCHED",
    })

    const result = await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1" })

    expect(textOf(result)).toContain("already LAUNCHED")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("rejects an explicit templateId whose tier doesn't match the requested tier", async () => {
    mockChecklistTemplate.findUnique.mockResolvedValueOnce({ ...templateWithItems, tier: "TIER_2" })

    const result = await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1", templateId: TEMPLATE_ID })

    expect(textOf(result)).toContain("TIER_2")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("returns a not-found message for an explicit templateId that doesn't exist", async () => {
    mockChecklistTemplate.findUnique.mockResolvedValueOnce(null)

    const result = await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1", templateId: "missing-template" })

    expect(textOf(result)).toContain("not found")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("returns a clear message when no active template exists for the tier and none was passed", async () => {
    mockChecklistTemplate.findFirst.mockResolvedValueOnce(null)

    const result = await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1" })

    const text = textOf(result)
    expect(text).toContain("create_checklist_template")
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it("happy path: creates checklist, then items, then flips horizon — in that order, in one transaction", async () => {
    const order: string[] = []
    mockLaunchChecklist.create.mockImplementation(() => {
      order.push("launchChecklist.create")
      return Promise.resolve({ id: CHECKLIST_ID })
    })
    mockLaunchChecklistItem.createMany.mockImplementation(() => {
      order.push("launchChecklistItem.createMany")
      return Promise.resolve({ count: 2 })
    })
    mockRoadmapItem.update.mockImplementation(() => {
      order.push("roadmapItem.update")
      return Promise.resolve({ id: ITEM_ID, horizon: "LAUNCHING" })
    })

    const result = await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1" })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(typeof mockPrisma.$transaction.mock.calls[0][0]).toBe("function")

    expect(order.indexOf("launchChecklist.create")).toBeLessThan(order.indexOf("launchChecklistItem.createMany"))
    expect(order.indexOf("launchChecklistItem.createMany")).toBeLessThan(order.indexOf("roadmapItem.update"))

    const roadmapUpdateArgs = mockRoadmapItem.update.mock.calls[0][0]
    expect(roadmapUpdateArgs.data.horizon).toBe("LAUNCHING")
    expect(roadmapUpdateArgs.data.updatedAt).toBeInstanceOf(Date)

    const text = textOf(result)
    expect(text).toContain("ID:")
    expect(text).not.toContain("**ID:**")
    expect(text).not.toMatch(/^Roadmap Item ID:/m)
  })

  it("uses the explicit templateId when its tier matches, without querying findFirst", async () => {
    await setLaunchTier({ itemId: ITEM_ID, tier: "TIER_1", templateId: TEMPLATE_ID })

    expect(mockChecklistTemplate.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEMPLATE_ID } })
    )
    expect(mockChecklistTemplate.findFirst).not.toHaveBeenCalled()
  })
})

describe("getLaunchChecklist", () => {
  it("returns a not-found message when the roadmap item does not exist", async () => {
    mockRoadmapItem.findUnique.mockResolvedValueOnce(null)

    const result = await getLaunchChecklist({ roadmapItemId: "missing-item" })

    expect(textOf(result)).toContain("not found")
  })

  it("returns a message when the item has no checklist yet", async () => {
    mockLaunchChecklist.findUnique.mockResolvedValueOnce(null)

    const result = await getLaunchChecklist({ roadmapItemId: ITEM_ID })

    expect(textOf(result)).toContain("set_launch_tier")
  })

  it("lists checklist items with their own bare ID lines", async () => {
    const result = await getLaunchChecklist({ roadmapItemId: ITEM_ID })

    const text = textOf(result)
    expect(text).toContain(`ID: ${CHECKLIST_ID}`)
    expect(text).toContain("ID: lci-1")
    expect(text).toContain("ID: lci-2")
    expect(text).toContain("[PENDING]")
    expect(text).toContain("[DONE]")
  })
})

describe("updateLaunchChecklistItem", () => {
  it("returns a not-found message when the item does not exist", async () => {
    mockLaunchChecklistItem.findUnique.mockResolvedValueOnce(null)

    const result = await updateLaunchChecklistItem({ itemId: "missing-item", status: "DONE" })

    expect(textOf(result)).toContain("not found")
    expect(mockLaunchChecklistItem.update).not.toHaveBeenCalled()
  })

  it("sets completedAt when marking DONE", async () => {
    await updateLaunchChecklistItem({ itemId: CHECKLIST_ITEM_ID, status: "DONE" })

    const data = mockLaunchChecklistItem.update.mock.calls[0][0].data
    expect(data.status).toBe("DONE")
    expect(data.completedAt).toBeInstanceOf(Date)
    expect(data.updatedAt).toBeInstanceOf(Date)
  })

  it("clears completedAt when marking PENDING or SKIPPED", async () => {
    await updateLaunchChecklistItem({ itemId: CHECKLIST_ITEM_ID, status: "SKIPPED" })

    const data = mockLaunchChecklistItem.update.mock.calls[0][0].data
    expect(data.status).toBe("SKIPPED")
    expect(data.completedAt).toBeNull()
  })

  it("returns a bare ID line", async () => {
    const result = await updateLaunchChecklistItem({ itemId: CHECKLIST_ITEM_ID, status: "DONE" })

    const text = textOf(result)
    expect(text).toContain(`ID: ${CHECKLIST_ITEM_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})
