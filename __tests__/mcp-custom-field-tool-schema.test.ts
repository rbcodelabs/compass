import { describe, expect, it, vi } from "vitest"
import { z, type ZodType } from "zod"

type ToolMeta = { inputSchema: Record<string, ZodType> }
const registeredTools: Record<string, ToolMeta> = {}

vi.mock("mcp-handler", () => ({
  createMcpHandler: (setup: (server: { registerTool: (name: string, meta: ToolMeta) => void; registerResource: (...args: unknown[]) => void }) => void) => {
    setup({ registerTool(name, meta) { registeredTools[name] = meta }, registerResource() {} })
    return () => new Response("ok")
  },
}))

vi.mock("@/lib/mcp-auth", () => ({
  validateMcpAuth: vi.fn().mockResolvedValue({ valid: true, userId: null }),
}))

await import("@/app/api/mcp/route")

const validUuid = "7df95340-297e-40e7-b021-42e2ecbf22e3"
const OBJECT_TYPES = ["OPPORTUNITY", "SOLUTION", "EXPERIMENT", "OBJECTIVE", "KEY_RESULT", "ROADMAP_ITEM", "TASK"]

describe("list_custom_field_definitions route registration metadata", () => {
  it("registers exactly workspaceId and an optional objectType", () => {
    const tool = registeredTools.list_custom_field_definitions
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema)).toEqual(["workspaceId", "objectType"])

    const schema = z.object(tool.inputSchema)
    expect(schema.safeParse({ workspaceId: validUuid }).success).toBe(true)
    for (const objectType of OBJECT_TYPES) {
      expect(schema.safeParse({ workspaceId: validUuid, objectType }).success).toBe(true)
    }
    expect(schema.safeParse({ workspaceId: validUuid, objectType: "NOT_A_TYPE" }).success).toBe(false)
    expect(schema.safeParse({ workspaceId: "not-a-uuid" }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })
})

describe("get_custom_field_values route registration metadata", () => {
  it("registers exactly objectType and objectId, both required", () => {
    const tool = registeredTools.get_custom_field_values
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema)).toEqual(["objectType", "objectId"])

    const schema = z.object(tool.inputSchema)
    for (const objectType of OBJECT_TYPES) {
      expect(schema.safeParse({ objectType, objectId: validUuid }).success).toBe(true)
    }
    expect(schema.safeParse({ objectType: "NOT_A_TYPE", objectId: validUuid }).success).toBe(false)
    expect(schema.safeParse({ objectType: "TASK", objectId: "not-a-uuid" }).success).toBe(false)
    expect(schema.safeParse({ objectType: "TASK" }).success).toBe(false)
    expect(schema.safeParse({ objectId: validUuid }).success).toBe(false)
  })
})

describe("set_custom_field_value route registration metadata", () => {
  it("registers objectType, objectId, fieldId, and value, all required", () => {
    const tool = registeredTools.set_custom_field_value
    expect(tool).toBeDefined()
    expect(Object.keys(tool.inputSchema)).toEqual(["objectType", "objectId", "fieldId", "value"])

    const schema = z.object(tool.inputSchema)
    const base = { objectType: "TASK", objectId: validUuid, fieldId: validUuid }

    expect(schema.safeParse({ ...base, value: "hello" }).success).toBe(true)
    expect(schema.safeParse({ ...base, value: 42 }).success).toBe(true)
    expect(schema.safeParse({ ...base, value: true }).success).toBe(true)
    expect(schema.safeParse({ ...base, value: ["a", "b"] }).success).toBe(true)
    expect(schema.safeParse({ ...base, value: null }).success).toBe(true)

    expect(schema.safeParse({ ...base, value: { nested: true } }).success).toBe(false)
    expect(schema.safeParse({ ...base, value: [1, 2] }).success).toBe(false)
    expect(schema.safeParse({ objectType: "TASK", objectId: validUuid, value: "x" }).success).toBe(false)
    expect(schema.safeParse({ ...base, objectType: "NOT_A_TYPE", value: "x" }).success).toBe(false)
    expect(schema.safeParse({ objectType: "TASK", objectId: "not-a-uuid", fieldId: validUuid, value: "x" }).success).toBe(false)
  })
})
