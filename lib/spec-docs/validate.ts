/**
 * Strict embed validation for SPEC docs, used ONLY by the agent write paths (MCP write_doc and edit_doc).
 * UI saves and Geode sync writes stay lenient: a malformed or dangling link there is kept as written, never
 * rejected and never silently stripped.
 *
 * Two layers: the pure strict parse (malformed link, unknown kind, id that is not a UUID), then one
 * workspace-filtered existence read per kind. A reference is only ever resolved with the DOC's workspace in
 * the WHERE clause, so an id that lives in another workspace is indistinguishable from one that does not
 * exist, and no message here ever says otherwise.
 */
import getPrisma from "@/lib/db"
import { parseDocEmbeds, type DocEmbedKind, type DocEmbedRef } from "@/lib/doc-embeds"
import type { LinkableEntityType } from "@/lib/entity-types"
import { resolveEndpoints } from "@/lib/links/endpoints"

/** Which entity type resolves each embed kind. Exhaustive: adding an embed kind fails the type check here. */
const ENTITY_TYPE_OF_KIND: Record<DocEmbedKind, LinkableEntityType> = {
  opportunity: "OPPORTUNITY",
  solution: "SOLUTION",
  metric: "METRIC",
  doc: "DOC",
  task: "TASK",
  experiment: "EXPERIMENT",
  objective: "OBJECTIVE",
  keyResult: "KEY_RESULT",
  assumption: "ASSUMPTION",
  roadmapItem: "ROADMAP_ITEM",
  artifact: "ARTIFACT",
}

const MAX_REPORTED = 5
/** Ids resolved per query. */
const RESOLVE_CHUNK = 200

/**
 * The error text for a SPEC doc body, or null when every embed is well formed and resolves in `workspaceId`.
 * `body` is the markdown body only (no frontmatter).
 */
export async function validateSpecEmbeds(input: { workspaceId: string; body: string }): Promise<string | null> {
  const { segments, issues } = parseDocEmbeds(input.body, { mode: "strict" })
  if (issues.length > 0) {
    const shown = issues.slice(0, MAX_REPORTED).map((issue) => `line ${issue.line}: ${issue.message}`)
    const more = issues.length > MAX_REPORTED ? ` (and ${issues.length - MAX_REPORTED} more)` : ""
    return `Spec doc has invalid compass:// links: ${shown.join("; ")}${more}. Use [title](compass://<kind>/<uuid>).`
  }

  const unique = new Map<string, DocEmbedRef>()
  for (const segment of segments) {
    if (segment.type === "embed") unique.set(`${segment.kind}:${segment.id.toLowerCase()}`, { kind: segment.kind, id: segment.id.toLowerCase() })
  }
  const idsByKind = new Map<DocEmbedKind, string[]>()
  for (const ref of unique.values()) idsByKind.set(ref.kind, [...(idsByKind.get(ref.kind) ?? []), ref.id])

  const db = getPrisma()
  const missing: string[] = []
  for (const [kind, ids] of idsByKind) {
    const found = new Set<string>()
    for (let at = 0; at < ids.length; at += RESOLVE_CHUNK) {
      for (const id of (await resolveEndpoints(db, ENTITY_TYPE_OF_KIND[kind], input.workspaceId, ids.slice(at, at + RESOLVE_CHUNK))).keys()) found.add(id.toLowerCase())
    }
    for (const id of ids) if (!found.has(id)) missing.push(`${kind} ${id}`)
  }
  if (missing.length === 0) return null
  const shown = missing.slice(0, MAX_REPORTED).join(", ")
  const more = missing.length > MAX_REPORTED ? ` (and ${missing.length - MAX_REPORTED} more)` : ""
  // One message for "does not exist" and "lives in another workspace": it never confirms that a foreign row exists.
  return `Spec doc links to records that were not found in this workspace: ${shown}${more}. Remove or replace those links.`
}
