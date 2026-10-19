import getPrisma from "@/lib/db"
import { assertWorkspaceMember, type McpActor } from "@/lib/mcp-authz"
import { MCP_REF_PARAMS } from "@/lib/mcp-work-item-refs"
import { classifyWorkItemRef, type WorkItemType } from "@/lib/work-item-ids"
import { resolveWorkItem } from "@/lib/work-item-resolve"
import { RestBadRequestError, RestNotFoundError } from "@/lib/rest/execute"
import type { RestRoute } from "@/lib/rest/registry"

/**
 * Display IDs (`TASK-12`) on the REST surface, in the same three places a UUID is accepted: the `{id}` path
 * segment of a work item collection, and the reference fields of a request body or query string
 * (`opportunityId`, `solutionId`, ... — the same names the MCP tools use).
 *
 * Runs before the route's zod schemas, which keep demanding UUIDs: a display ID is swapped for the row's UUID
 * first, so the registry, every handler and the generated OpenAPI types are unchanged. The caller must be able to
 * use the path's workspace before any lookup, so a display ID never reveals rows in a workspace the caller cannot
 * see; every unresolvable reference is the same 404 as an unknown UUID.
 */
const COLLECTION_TYPES: Readonly<Record<string, WorkItemType>> = {
  objectives: "objective",
  "key-results": "keyResult",
  opportunities: "opportunity",
  solutions: "solution",
  assumptions: "assumption",
  experiments: "experiment",
  tasks: "task",
  "roadmap-items": "roadmapItem",
  feedback: "feedback",
  "review-requests": "reviewRequest",
  docs: "doc",
  artifacts: "artifact",
  "research-studies": "researchStudy",
}

/** The work item type behind `{id}` for a route like `/api/v1/workspaces/{workspaceId}/tasks/{id}/...`, if any. */
export function pathIdType(routePath: string): WorkItemType | null {
  const segments = routePath.split("/")
  const index = segments.indexOf("{id}")
  if (index < 1) return null
  const collection = segments[index - 1]
  return Object.hasOwn(COLLECTION_TYPES, collection) ? COLLECTION_TYPES[collection] : null
}

const isDisplayId = (value: unknown): value is string => typeof value === "string" && classifyWorkItemRef(value).kind === "display"

export type RestRefInputs = { params: Record<string, string>; query: Record<string, unknown>; body: unknown }

export async function resolveRestRefs(route: RestRoute, input: RestRefInputs, actor: McpActor): Promise<RestRefInputs> {
  const idType = pathIdType(route.path)
  const body = input.body && typeof input.body === "object" && !Array.isArray(input.body) ? (input.body as Record<string, unknown>) : null

  const wanted: Array<{ where: "params" | "query" | "body"; key: string; type: WorkItemType; value: string }> = []
  if (idType && isDisplayId(input.params.id)) wanted.push({ where: "params", key: "id", type: idType, value: input.params.id })
  for (const [key, type] of Object.entries(MCP_REF_PARAMS)) {
    if (isDisplayId(input.query[key])) wanted.push({ where: "query", key, type, value: input.query[key] as string })
    if (body && isDisplayId(body[key])) wanted.push({ where: "body", key, type, value: body[key] as string })
  }
  if (wanted.length === 0) return input

  const workspaceId = input.params.workspaceId
  // Display IDs are per workspace, so only routes under /workspaces/{workspaceId} can use them.
  if (typeof workspaceId !== "string" || classifyWorkItemRef(workspaceId).kind !== "uuid") throw new RestNotFoundError()
  await assertWorkspaceMember({ ...actor }, workspaceId)

  const prisma = getPrisma()
  const params = { ...input.params }
  const query = { ...input.query }
  const nextBody = body ? { ...body } : input.body
  for (const { where, key, type, value } of wanted) {
    const result = await resolveWorkItem(prisma, workspaceId, type, value)
    if (!result.ok) {
      if (result.reason === "wrong_type") throw new RestBadRequestError(result.message)
      throw new RestNotFoundError()
    }
    if (where === "params") params[key] = result.id
    else if (where === "query") query[key] = result.id
    else (nextBody as Record<string, unknown>)[key] = result.id
  }
  return { params, query, body: nextBody }
}
