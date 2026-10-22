/**
 * Reading the DOC_SPECIFIES_SCOPE links of SPEC docs (spec docs phase 2). All reads go through the generic link service, which
 * verifies the viewed entity in the workspace and drops any link whose other end is missing, foreign or NULL-workspace, so a stale or
 * drifted row is never shown. Nothing here writes.
 */
import type { AppTransactionClient } from "@/lib/db"
import { DOC_SPECIFIES_SCOPE_LINK_TYPE } from "@/lib/links/registry"
import { listLinks } from "@/lib/links/service"

export const SPEC_SCOPE_TYPES = ["SOLUTION", "OPPORTUNITY"] as const
export type SpecScopeType = (typeof SPEC_SCOPE_TYPES)[number]

export function isSpecScopeType(value: unknown): value is SpecScopeType {
  return typeof value === "string" && (SPEC_SCOPE_TYPES as readonly string[]).includes(value)
}

/** `solution:<uuid>` / `opportunity:<uuid>`: the value format of the reserved `compass_scopes` frontmatter list. */
export function scopeFrontmatterValue(scopeType: SpecScopeType, scopeId: string): string {
  return `${scopeType.toLowerCase()}:${scopeId}`
}

const PAGE = 100
/** A hard stop so a pathological entity cannot make one read unbounded. */
const MAX_PAGES = 20

async function everyLink(db: AppTransactionClient, input: { workspaceId: string; entityType: string; entityId: string }) {
  const items: Awaited<ReturnType<typeof listLinks>>["items"] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await listLinks(db, { ...input, linkType: DOC_SPECIFIES_SCOPE_LINK_TYPE, limit: PAGE, cursor })
    items.push(...result.items)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return items
}

/** The scopes one doc specifies, oldest link first, as `{ scopeType, scopeId }`. Empty for a doc with none. */
export async function listScopesForDoc(db: AppTransactionClient, workspaceId: string, docId: string): Promise<{ scopeType: SpecScopeType; scopeId: string }[]> {
  const items = await everyLink(db, { workspaceId, entityType: "DOC", entityId: docId })
  return items.flatMap((item) => (item.side === "from" && isSpecScopeType(item.to.type) ? [{ scopeType: item.to.type, scopeId: item.to.id }] : []))
}

/** The `compass_scopes` frontmatter values for a doc. */
export async function listScopeFrontmatterForDoc(db: AppTransactionClient, workspaceId: string, docId: string): Promise<string[]> {
  return (await listScopesForDoc(db, workspaceId, docId)).map((scope) => scopeFrontmatterValue(scope.scopeType, scope.scopeId))
}

/** The ids of the docs linked to one scope (every docType; the caller filters to SPEC), oldest link first. */
export async function listDocIdsForScope(db: AppTransactionClient, workspaceId: string, scopeType: SpecScopeType, scopeId: string): Promise<string[]> {
  const items = await everyLink(db, { workspaceId, entityType: scopeType, entityId: scopeId })
  return items.flatMap((item) => (item.side === "to" && item.from.type === "DOC" ? [item.from.id] : []))
}
