import { notFound, permanentRedirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { canonicalRedirectSegment, resolveWorkItem, type ResolvedWorkItem } from "@/lib/work-item-resolve"
import type { WorkItemType } from "@/lib/work-item-ids"

export type PageSearchParams = Record<string, string | string[] | undefined> | undefined

function queryString(searchParams: PageSearchParams): string {
  if (!searchParams) return ""
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, entry)
  }
  const text = query.toString()
  return text ? `?${text}` : ""
}

/**
 * Resolves the work item segment of a detail-page URL (a UUID or a display ID like `TASK-5`) inside an
 * already-authorized workspace. Unknown, foreign and malformed references are a 404. A reference that is
 * not the canonical form (a UUID for a numbered row, or `task-5`) is a 308 to the canonical URL, with the
 * query string kept, so old links keep working and converge on `/tasks/TASK-5`.
 *
 * `basePath` is the URL up to, not including, the work item segment (`/org/ws/tasks`). `suffix` is any
 * path that follows the segment on a nested page (`/sessions/<id>`) and is kept on the redirect.
 */
export async function resolveWorkItemPage(args: {
  type: WorkItemType
  param: string
  workspaceId: string
  basePath: string
  suffix?: string
  searchParams?: PageSearchParams
}): Promise<ResolvedWorkItem> {
  const result = await resolveWorkItem(getPrisma(), args.workspaceId, args.type, args.param)
  if (!result.ok) notFound()
  const segment = canonicalRedirectSegment(args.param, result)
  if (segment) permanentRedirect(`${args.basePath}/${encodeURIComponent(segment)}${args.suffix ?? ""}${queryString(args.searchParams)}`)
  return result
}
