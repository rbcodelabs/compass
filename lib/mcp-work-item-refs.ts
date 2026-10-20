import { z } from "zod"
import getPrisma from "@/lib/db"
import { assertWorkspaceMember, type McpActor } from "@/lib/mcp-authz"
import { classifyWorkItemRef, WORK_ITEM_REGISTRY, type WorkItemType } from "@/lib/work-item-ids"
import { resolveWorkItem } from "@/lib/work-item-resolve"

/**
 * Display IDs (`TASK-12`) on the MCP surface (ADR "Human-readable work item IDs", section 7).
 *
 * Every tool parameter named in MCP_REF_PARAMS used to be `z.string().uuid()`. `widenRefSchemas` turns each of
 * those into "UUID or display ID" at registration time, and `resolveToolRefs` turns any display ID back into the
 * UUID before the tool's gate and handler run, so every handler, authorization gate and receipt keeps seeing UUIDs.
 *
 * A display ID is only unique inside a workspace, so it needs one: tools that already take `workspaceId` use it,
 * and tools that did not (get_task takes only taskId) gain an optional `workspaceId` that is required exactly when
 * a display ID is passed. The caller must be able to use that workspace before anything is looked up in it, so a
 * display ID never reveals whether a row exists in a workspace the caller cannot see.
 *
 * Ambiguous names are left alone on purpose: `itemId` is a roadmap item in one tool and a checklist item in
 * another, and polymorphic `objectId`/`targetId`/`linkedId` carry their type in a sibling field.
 */
export const MCP_REF_PARAMS: Readonly<Record<string, WorkItemType>> = {
  objectiveId: "objective",
  keyResultId: "keyResult",
  parentKeyResultId: "keyResult",
  opportunityId: "opportunity",
  solutionId: "solution",
  assumptionId: "assumption",
  experimentId: "experiment",
  taskId: "task",
  parentTaskId: "task",
  roadmapItemId: "roadmapItem",
  feedbackId: "feedback",
  requestId: "reviewRequest",
  docId: "doc",
  artifactId: "artifact",
  studyId: "researchStudy",
}

type AnyZod = z.ZodType

function isUuidString(schema: AnyZod): { wrap: "none" | "optional" | "nullable" | "nullish"; description: string | undefined } | null {
  let current = schema as unknown as { def?: { type?: string; innerType?: unknown; format?: string }; format?: string; description?: string }
  let optional = false
  let nullable = false
  let description = (schema as { description?: string }).description
  for (let depth = 0; depth < 4 && current?.def; depth++) {
    const type = current.def.type
    if (type === "optional") optional = true
    else if (type === "nullable") nullable = true
    else if (type === "string") {
      if (current.format !== "uuid") return null
      description ??= current.description
      const wrap = optional && nullable ? "nullish" : optional ? "optional" : nullable ? "nullable" : "none"
      return { wrap, description }
    } else return null
    current = current.def.innerType as typeof current
    description ??= current?.description
  }
  return null
}

const REF_HINT = "a UUID, or a display ID like TASK-12 together with workspaceId"

function refSchema(type: WorkItemType, wrap: "none" | "optional" | "nullable" | "nullish", description: string | undefined): AnyZod {
  const label = WORK_ITEM_REGISTRY[type].label
  let schema: AnyZod = z
    .string()
    .trim()
    .refine((value) => classifyWorkItemRef(value).kind !== "invalid", { message: `Expected a ${label} UUID or a display ID like ${WORK_ITEM_REGISTRY[type].prefix}-12` })
  const base = description ? description.replace(/^UUID of /i, "") : label
  schema = schema.describe(`${base} (${REF_HINT})`)
  if (wrap === "optional") schema = schema.optional()
  else if (wrap === "nullable") schema = schema.nullable()
  else if (wrap === "nullish") schema = schema.nullish()
  return schema
}

/** Returns a copy of a tool's `inputSchema` shape that accepts display IDs in the mapped parameters. */
export function widenRefSchemas<T>(inputSchema: T): T {
  if (!inputSchema || typeof inputSchema !== "object" || typeof (inputSchema as { parse?: unknown }).parse === "function") return inputSchema
  const shape = inputSchema as Record<string, AnyZod>
  const widened: Record<string, AnyZod> = {}
  let changed = false
  for (const [key, schema] of Object.entries(shape)) {
    const type = Object.hasOwn(MCP_REF_PARAMS, key) ? MCP_REF_PARAMS[key] : undefined
    const uuid = type && schema && typeof schema === "object" ? isUuidString(schema) : null
    if (type && uuid) {
      widened[key] = refSchema(type, uuid.wrap, uuid.description)
      changed = true
    } else widened[key] = schema
  }
  if (!changed) return inputSchema
  if (!("workspaceId" in widened)) {
    widened.workspaceId = z.string().uuid().optional().describe("UUID of the workspace. Required only when an ID parameter is a display ID such as TASK-12; display IDs are unique per workspace.")
  }
  return widened as T
}

export class McpRefError extends Error {}

/**
 * Replaces every display ID in `args` with the row's UUID, resolved inside `args.workspaceId` after checking the
 * caller may use that workspace. Arguments with no display ID are returned untouched (same object), so a UUID-only
 * call behaves and costs exactly what it did before.
 */
export async function resolveToolRefs<A extends Record<string, unknown>>(actor: McpActor, args: A): Promise<A> {
  const pending: Array<[string, string, WorkItemType]> = []
  for (const [key, type] of Object.entries(MCP_REF_PARAMS)) {
    const value = args[key]
    if (typeof value === "string" && classifyWorkItemRef(value).kind === "display") pending.push([key, value, type])
  }
  if (pending.length === 0) return args

  const workspaceId = args.workspaceId
  if (typeof workspaceId !== "string" || classifyWorkItemRef(workspaceId).kind !== "uuid") {
    throw new McpRefError(`${pending[0][1]} is a display ID; pass workspaceId (a UUID) as well, since display IDs are unique per workspace.`)
  }
  // Same membership and scope check every workspace tool starts with, on a copy so the real actor stays untouched
  // until the tool's own gate runs.
  await assertWorkspaceMember({ ...actor }, workspaceId)

  const prisma = getPrisma()
  const resolved: Record<string, unknown> = { ...args }
  for (const [key, value, type] of pending) {
    const result = await resolveWorkItem(prisma, workspaceId, type, value)
    if (!result.ok) throw new McpRefError(result.reason === "not_found" ? `${value} was not found in this workspace.` : result.message)
    resolved[key] = result.id
  }
  return resolved as A
}
