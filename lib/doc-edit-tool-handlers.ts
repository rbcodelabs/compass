/**
 * Handlers for the Docs *edit* MCP tools: edit_doc (text str_replace), edit_canvas (domain ops on a Canvas doc)
 * and build_canvas_tree (draw the OST onto a Canvas). Each one sends an intent instead of the whole document;
 * the server loads the current body, applies it, validates, and saves with a revision compare-and-swap
 * (see lib/document-edit.ts). Kept apart from lib/doc-tool-handlers.ts so the whole-document tools stay small.
 */
import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { applyCanvasOps, newCanvasNodeId, type CanvasOp } from "@/lib/canvas-edit"
import { editDocumentBody, type EditOutcome } from "@/lib/document-edit"
import { normalizeCanvasContent, serializeJsonCanvas } from "@/lib/json-canvas"
import { getCanvasOverview } from "@/lib/canvas/data"
import { buildTreeFragment, mergeTreeIntoCanvas, MAX_TREE_CARDS, TREE_SCOPE_KINDS, type TreeFragment, type TreeScope } from "@/lib/canvas-tree"
import { layoutTreeCards } from "@/lib/canvas-tree-layout"
import { isUuid } from "@/lib/canvas-cards"
import { resolveThinkingModel } from "@/lib/thinking-model/resolve"

type Failed = Extract<EditOutcome<unknown>, { ok: false }>
const editFailure = (outcome: Failed) => fail(outcome.error)

// ── edit_doc ─────────────────────────────────────────────────────────────────

export type TextEdit = { oldString: string; newString: string; replaceAll?: boolean }

export const MAX_TEXT_EDITS = 50

/** Pure str_replace over a body. Every edit must match; the whole batch is rejected on the first that does not. */
export function applyTextEdits(body: string, edits: TextEdit[]): { ok: true; content: string; replacements: number } | { ok: false; error: string } {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "Provide oldString/newString, or a non-empty edits array." }
  if (edits.length > MAX_TEXT_EDITS) return { ok: false, error: `Too many edits (${edits.length}); the limit is ${MAX_TEXT_EDITS} per call.` }
  let content = body
  let replacements = 0
  for (const [index, edit] of edits.entries()) {
    const label = edits.length > 1 ? `edits[${index}]: ` : ""
    if (typeof edit?.oldString !== "string" || typeof edit?.newString !== "string") return { ok: false, error: `${label}oldString and newString must be strings.` }
    if (edit.oldString === "") return { ok: false, error: `${label}oldString must not be empty.` }
    if (edit.oldString === edit.newString) return { ok: false, error: `${label}oldString and newString are identical.` }
    let count = 0
    for (let at = content.indexOf(edit.oldString); at !== -1; at = content.indexOf(edit.oldString, at + edit.oldString.length)) count++
    if (count === 0) {
      return { ok: false, error: `${label}oldString was not found in the doc body. Frontmatter properties are not part of the body: change them with update_doc_metadata. Re-read with get_doc and copy the text exactly, including whitespace.` }
    }
    if (count > 1 && !edit.replaceAll) {
      return { ok: false, error: `${label}oldString matches ${count} places. Include more surrounding text to make it unique, or set replaceAll.` }
    }
    // Function replacer so "$&" and friends in newString are inserted literally.
    content = edit.replaceAll ? content.split(edit.oldString).join(edit.newString) : content.replace(edit.oldString, () => edit.newString)
    replacements += edit.replaceAll ? count : 1
  }
  return { ok: true, content, replacements }
}

export async function editDoc({
  docId,
  oldString,
  newString,
  replaceAll,
  edits,
  expectedRevision,
}: {
  docId: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  edits?: TextEdit[]
  expectedRevision?: string
}) {
  const single = oldString !== undefined || newString !== undefined
  if (single && edits) return fail("Give either oldString/newString or edits, not both.")
  if (single && (oldString === undefined || newString === undefined)) return fail("oldString and newString must be given together.")
  const list: TextEdit[] | undefined = single ? [{ oldString: oldString!, newString: newString!, replaceAll }] : edits

  const outcome = await editDocumentBody(
    docId,
    (doc) => {
      const applied = applyTextEdits(doc.content, list ?? [])
      if (!applied.ok) return applied
      let content = applied.content
      if (doc.docType === "CANVAS") {
        // A text edit of a canvas must still leave a valid canvas; store the canonical form.
        const canvas = normalizeCanvasContent(content, { strictCards: true })
        if (!canvas.ok) return { ok: false, error: canvas.error }
        content = canvas.content
      }
      return { ok: true, content, result: { replacements: applied.replacements, docType: doc.docType } }
    },
    { expectedRevision }
  )
  if (!outcome.ok) return editFailure(outcome)
  return ok(
    `**Doc edited**\nID: ${outcome.doc.id}\nReplacements: ${outcome.result.replacements}\nRevision: ${outcome.doc.revision}`,
    { id: outcome.doc.id, replacements: outcome.result.replacements, revision: outcome.doc.revision, updatedAt: outcome.doc.updatedAt.toISOString() }
  )
}

// ── edit_canvas ──────────────────────────────────────────────────────────────

export async function editCanvas({ docId, ops, expectedRevision }: { docId: string; ops: CanvasOp[]; expectedRevision?: string }) {
  const outcome = await editDocumentBody(
    docId,
    (doc) => {
      if (doc.docType !== "CANVAS") return { ok: false, error: `Doc "${docId}" is a ${doc.docType} doc, not a CANVAS. Use edit_doc for text docs.` }
      const current = normalizeCanvasContent(doc.content)
      if (!current.ok) return { ok: false, error: current.error }
      const applied = applyCanvasOps(current.canvas, ops)
      if (!applied.ok) return { ok: false, error: applied.error }
      const next = normalizeCanvasContent(serializeJsonCanvas(applied.canvas), { strictCards: true })
      if (!next.ok) return { ok: false, error: next.error }
      return { ok: true, content: next.content, result: applied.summary }
    },
    { expectedRevision }
  )
  if (!outcome.ok) return editFailure(outcome)
  const s = outcome.result
  const parts = [
    s.addedNodes && `${s.addedNodes} node${s.addedNodes === 1 ? "" : "s"} added`,
    s.addedEdges && `${s.addedEdges} edge${s.addedEdges === 1 ? "" : "s"} added`,
    s.updated && `${s.updated} updated`,
    s.moved && `${s.moved} moved`,
    s.removedNodes && `${s.removedNodes} node${s.removedNodes === 1 ? "" : "s"} removed`,
    s.removedEdges && `${s.removedEdges} edge${s.removedEdges === 1 ? "" : "s"} removed`,
    s.skipped && `${s.skipped} already present`,
  ].filter(Boolean)
  return ok(
    `**Canvas edited**\nID: ${outcome.doc.id}\n${parts.length ? parts.join(", ") : "No changes"}\nRevision: ${outcome.doc.revision}`,
    { id: outcome.doc.id, revision: outcome.doc.revision, changed: outcome.changed, ...s }
  )
}

// ── build_canvas_tree ────────────────────────────────────────────────────────

function parseScope(scope: unknown): TreeScope | null {
  const value = scope as { kind?: unknown; id?: unknown } | null | undefined
  if (!value || typeof value !== "object" || value.kind === "workspace") return { kind: "workspace" }
  if ((TREE_SCOPE_KINDS as readonly unknown[]).includes(value.kind) && isUuid(value.id)) {
    return { kind: value.kind as (typeof TREE_SCOPE_KINDS)[number], id: value.id.toLowerCase() }
  }
  return null
}

/**
 * Draw the OST (whole workspace, or the subtree under one objective / key result / opportunity / solution) onto a
 * Canvas doc. Same engine as the editor's "Build tree": existing cards are never duplicated, only new content is
 * added (to the right of what is there, auto-laid-out with ELK), one group per root objective.
 */
export async function buildCanvasTree({ docId, scope, expectedRevision }: { docId: string; scope?: unknown; expectedRevision?: string }) {
  const parsed = parseScope(scope)
  if (!parsed) return fail(`Invalid scope. Use { "kind": "workspace" } or { "kind": "${TREE_SCOPE_KINDS.join('" | "')}", "id": "<uuid>" }.`)

  const prisma = getPrisma()
  const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { workspaceId: true, docType: true } })
  if (!doc) return fail(`Doc "${docId}" not found.`)
  if (doc.docType !== "CANVAS") return fail(`Doc "${docId}" is a ${doc.docType} doc, not a CANVAS.`)

  const workspace = await prisma.workspace.findUnique({ where: { id: doc.workspaceId }, select: { thinkingModel: true, thinkingModelLabels: true } })
  if (!workspace) return fail("Workspace not found.")
  const { links } = resolveThinkingModel(workspace)
  const overview = await getCanvasOverview(prisma, doc.workspaceId, { linkOrigins: links.oppToObjective === "hidden" ? "DIRECT" : "ALL" })
  // The scope id is only ever looked up inside this doc's workspace overview, so a foreign id yields an empty tree.
  const fragment: TreeFragment = buildTreeFragment(overview, { scope: parsed, edgeOptions: { links } })
  if (fragment.cards.length === 0) {
    return ok(parsed.kind === "workspace" ? "There is nothing in this workspace to draw yet." : "Nothing sits beneath that item yet.", { id: docId, addedCards: 0, addedEdges: 0, addedGroups: 0, skippedCards: 0, truncated: false })
  }
  let positions: Awaited<ReturnType<typeof layoutTreeCards>>
  try {
    positions = await layoutTreeCards(fragment.cards, fragment.edges)
  } catch {
    positions = new Map() // merge falls back to a simple column, so a layout failure still yields a usable canvas
  }

  const outcome = await editDocumentBody(
    docId,
    (current) => {
      const canvas = normalizeCanvasContent(current.content)
      if (!canvas.ok) return { ok: false, error: canvas.error }
      const merged = mergeTreeIntoCanvas(canvas.canvas, fragment, positions, newCanvasNodeId)
      if (!merged.ok) return { ok: false, error: "This canvas is too large to add the tree. Build into a new canvas, or start from a smaller item." }
      if (merged.addedCards === 0) return { ok: true, content: current.content, result: merged }
      const next = normalizeCanvasContent(serializeJsonCanvas(merged.canvas), { strictCards: true })
      if (!next.ok) return { ok: false, error: next.error }
      return { ok: true, content: next.content, result: merged }
    },
    { expectedRevision }
  )
  if (!outcome.ok) return editFailure(outcome)
  const merged = outcome.result
  if (!merged.ok) return fail("This canvas is too large to add the tree.")
  const summary = { addedCards: merged.addedCards, addedEdges: merged.addedEdges, addedGroups: merged.addedGroups, skippedCards: merged.skippedCards }
  const truncatedNote = fragment.truncated ? ` The tree is larger than ${MAX_TREE_CARDS} cards, so only the top of it was drawn; build again from a specific item to see the rest.` : ""
  return ok(
    merged.addedCards === 0
      ? "Everything in that tree is already on this canvas."
      : `**Tree added**\nID: ${outcome.doc.id}\nAdded ${merged.addedCards} card(s), ${merged.addedEdges} edge(s), ${merged.addedGroups} group(s); ${merged.skippedCards} already present.${truncatedNote}\nRevision: ${outcome.doc.revision}`,
    { id: outcome.doc.id, revision: outcome.doc.revision, ...summary, truncated: fragment.truncated }
  )
}
