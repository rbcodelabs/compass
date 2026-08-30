import { beforeEach, describe, expect, it, vi } from "vitest"
import { runWithMcpActor } from "@/lib/mcp-authz"

const mockPrisma = {
  opportunity: {
    findMany: vi.fn(),
  },
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}))

type ToolResult = {
  content: Array<{ type: string; text: string }>
  structuredContent: {
    ok: boolean
    message: string
    data: unknown
  }
}

type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult>

const registeredTools: Record<string, ToolCallback> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (
    setup: (server: {
      registerTool: (name: string, meta: unknown, callback: ToolCallback) => void
    }) => void,
  ) => {
    setup({
      registerTool(name, _meta, callback) {
        registeredTools[name] = callback
      },
    })
    return () => new Response("ok")
  },
}))

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true }),
}))

await import("@/app/api/mcp/route")

function getHandler(name: string): ToolCallback {
  const handler = registeredTools[name]
  if (!handler) throw new Error(`Tool "${name}" was not registered`)
  return (args) => runWithMcpActor({ userId: null }, () => handler(args))
}

describe("list_opportunities MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("includes non-empty descriptions in text and structured output while preserving list metadata", async () => {
    mockPrisma.opportunity.findMany.mockResolvedValue([
      {
        id: "opportunity-1",
        title: "Understand failed onboarding",
        description: "New admins cannot tell which setup step failed.",
        status: "VALIDATING",
        squad: { name: "Activation" },
        linkedKeyResult: {
          title: "Increase activated workspaces",
          objective: { title: "Improve onboarding" },
        },
        _count: { solutions: 2 },
      },
    ])

    const result = await getHandler("list_opportunities")({
      workspaceId: "workspace-1",
      status: "VALIDATING",
      squadId: "squad-1",
    })

    expect(result.content[0].text).toContain("New admins cannot tell which setup step failed.")
    expect(result.structuredContent.data).toEqual({
      items: [
        {
          id: "opportunity-1",
          title: "Understand failed onboarding",
          description: "New admins cannot tell which setup step failed.",
          status: "VALIDATING",
          squad: "Activation",
          solutions: 2,
          linkedKeyResult: {
            title: "Increase activated workspaces",
            objective: "Improve onboarding",
          },
        },
      ],
      count: 1,
    })
    expect(mockPrisma.opportunity.findMany).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace-1",
        status: "VALIDATING",
        squadId: "squad-1",
      },
      include: {
        linkedKeyResult: {
          select: { title: true, objective: { select: { title: true } } },
        },
        squad: { select: { name: true } },
        _count: { select: { solutions: true } },
      },
      orderBy: { createdAt: "desc" },
    })
  })

  it("preserves null descriptions in structured output without printing literal null", async () => {
    mockPrisma.opportunity.findMany.mockResolvedValue([
      {
        id: "opportunity-2",
        title: "Unspecified opportunity",
        description: null,
        status: "EXPLORING",
        squad: null,
        linkedKeyResult: null,
        _count: { solutions: 0 },
      },
    ])

    const result = await getHandler("list_opportunities")({ workspaceId: "workspace-1" })
    const data = result.structuredContent.data as {
      items: Array<{ description: string | null }>
    }

    expect(data.items[0].description).toBeNull()
    expect(result.content[0].text).not.toContain("null")
  })
})
