import { beforeEach, describe, expect, it, vi } from "vitest"

const mockPrisma = {
  workspace: { findUnique: vi.fn() },
  squad: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

const mockRevalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

import {
  createSquad,
  getSquad,
  listSquads,
  updateSquad,
} from "@/lib/squad-tool-handlers"

const workspace = {
  id: "workspace-id",
  slug: "compass",
  organization: { slug: "rbcodelabs" },
}

beforeEach(() => vi.clearAllMocks())

describe("createSquad", () => {
  it("creates an MCP-sourced squad and returns its ID", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(workspace)
    mockPrisma.squad.create.mockResolvedValue({
      id: "squad-id", name: "Platform", color: "#0ea5e9",
    })

    const result = await createSquad({
      workspaceId: "workspace-id", name: "  Platform  ", color: "#0ea5e9",
    })

    expect(mockPrisma.squad.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace-id",
        name: "Platform",
        color: "#0ea5e9",
        source: "MCP",
      },
    })
    expect(result.content[0].text).toContain("ID: squad-id")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rbcodelabs/compass", "layout")
  })

  it("uses the product default color when none is supplied", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(workspace)
    mockPrisma.squad.create.mockResolvedValue({
      id: "squad-id", name: "Growth", color: "#6366f1",
    })

    await createSquad({ workspaceId: "workspace-id", name: "Growth" })

    expect(mockPrisma.squad.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ color: "#6366f1" }),
    })
  })

  it("does not create a squad when the workspace does not exist", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null)

    const result = await createSquad({ workspaceId: "missing", name: "Platform" })

    expect(result.content[0].text).toContain("No workspace found")
    expect(mockPrisma.squad.create).not.toHaveBeenCalled()
    expect(mockRevalidatePath).not.toHaveBeenCalled()
  })
})

describe("listSquads", () => {
  it("lists squad IDs, names, and colors", async () => {
    mockPrisma.squad.findMany.mockResolvedValue([
      { id: "squad-id", name: "Platform", color: "#0ea5e9" },
    ])

    const result = await listSquads({ workspaceId: "workspace-id" })

    expect(result.content[0].text).toContain("Platform")
    expect(result.content[0].text).toContain("#0ea5e9")
    expect(result.content[0].text).toContain("squad-id")
  })
})

describe("getSquad", () => {
  it("returns full squad detail", async () => {
    mockPrisma.squad.findUnique.mockResolvedValue({
      id: "squad-id", workspaceId: "workspace-id", name: "Platform", color: "#0ea5e9",
    })

    const result = await getSquad({ squadId: "squad-id" })

    expect(result.content[0].text).toContain("ID: squad-id")
    expect(result.content[0].text).toContain("Workspace ID: workspace-id")
  })

  it("reports a missing squad", async () => {
    mockPrisma.squad.findUnique.mockResolvedValue(null)
    const result = await getSquad({ squadId: "missing" })
    expect(result.content[0].text).toContain("not found")
  })
})

describe("updateSquad", () => {
  it("updates supplied fields and revalidates the workspace", async () => {
    mockPrisma.squad.findUnique.mockResolvedValue({ id: "squad-id", workspace })
    mockPrisma.squad.update.mockResolvedValue({
      id: "squad-id", name: "Core Platform", color: "#14b8a6",
    })

    const result = await updateSquad({
      squadId: "squad-id", name: "  Core Platform  ", color: "#14b8a6",
    })

    expect(mockPrisma.squad.update).toHaveBeenCalledWith({
      where: { id: "squad-id" },
      data: { name: "Core Platform", color: "#14b8a6" },
    })
    expect(result.content[0].text).toContain("ID: squad-id")
    expect(mockRevalidatePath).toHaveBeenCalledWith("/rbcodelabs/compass", "layout")
  })

  it("does not update a missing squad", async () => {
    mockPrisma.squad.findUnique.mockResolvedValue(null)
    const result = await updateSquad({ squadId: "missing", name: "New name" })
    expect(result.content[0].text).toContain("not found")
    expect(mockPrisma.squad.update).not.toHaveBeenCalled()
  })
})
