/**
 * Sandbox reconciliation for the in-app agent's doc-tree projection (ADR 0019
 * §2.4 — Projection 1). Compares the workspace's doc tree as it was
 * materialized at turn start ("baseline") against the tree
 * `turn-entry.ts` reports at turn end ("final"), and produces the exact set of
 * doc-fs mutations needed to bring the database in line with what the agent's
 * file edits actually did.
 *
 * `planReconciliation` is pure — no I/O, no Prisma, no sandbox — so the
 * genuinely hard part of this design (identity tracking across
 * create/move/delete/no-op, spec table in §2.4) is unit-testable without a
 * database or a live sandbox. `applyReconciliationPlan` is the thin glue that
 * turns a plan into real lib/doc-fs.ts calls and reports conflicts.
 *
 * Identity rule (spec §2.4): identity is carried ONLY by a doc's own
 * `compass_doc_id`, validated against this turn's baseline — never inferred
 * from path or content similarity. A frontmatter id that isn't a real baseline
 * docId (missing, malformed, or copy-pasted from another file) is treated as
 * "no id", i.e. a create.
 */

import { createHash } from "node:crypto"
import * as docFs from "@/lib/doc-fs"
import { DocumentError } from "@/lib/document-service"

export type DocBaselineEntry = { path: string; docId: string; revision: string | null; content: string }
export type DocFinalFile = { path: string; content: string; frontmatterDocId: string | null }

export type ReconciliationAction =
  | { type: "noop"; path: string; docId: string }
  | { type: "update"; path: string; docId: string; content: string; expectedRevision: string | null }
  | { type: "move"; fromPath: string; toPath: string; docId: string; expectedRevision: string | null }
  | { type: "moveAndUpdate"; fromPath: string; toPath: string; docId: string; content: string; expectedRevision: string | null }
  | { type: "delete"; path: string; docId: string; expectedRevision: string | null }
  | { type: "create"; path: string; content: string }

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Longest common prefix length, used to pick the "lexically closest" path among duplicate ids. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/**
 * Builds the reconciliation plan. See the module comment and spec §2.4's
 * table for the six per-entry outcomes this implements.
 */
export function planReconciliation(baseline: readonly DocBaselineEntry[], final: readonly DocFinalFile[]): ReconciliationAction[] {
  const baselineById = new Map(baseline.map((b) => [b.docId, b]))
  const baselineHash = new Map(baseline.map((b) => [b.docId, sha256(b.content)]))

  // Group final entries by VALIDATED docId. An id is only trusted if it was a
  // real docId in this turn's own baseline — anything else degrades to "no id".
  const groups = new Map<string, DocFinalFile[]>()
  const untraced: DocFinalFile[] = []
  for (const entry of final) {
    const id = entry.frontmatterDocId
    if (id && baselineById.has(id)) {
      if (!groups.has(id)) groups.set(id, [])
      groups.get(id)!.push(entry)
    } else {
      untraced.push(entry)
    }
  }

  const actions: ReconciliationAction[] = []
  const creates: DocFinalFile[] = [...untraced]

  for (const [docId, entries] of groups) {
    const base = baselineById.get(docId)!
    // Duplicate occurrences of the same id: the one lexically closest to the
    // baseline path wins as the real move/update; every other occurrence is a
    // duplicated file and becomes a new doc (its id is not trustworthy for
    // more than one final path). An exact match always wins outright --
    // otherwise a duplicate at "X" plus one at "X Copy" would tie on longest
    // common prefix (the whole of "X" is a prefix of "X Copy" too), and the
    // unchanged original must never lose that tie to a copy.
    let winner = entries[0]
    let winnerScore = winner.path === base.path ? Infinity : commonPrefixLength(base.path, winner.path)
    for (const candidate of entries.slice(1)) {
      const score = candidate.path === base.path ? Infinity : commonPrefixLength(base.path, candidate.path)
      if (score > winnerScore) {
        winner = candidate
        winnerScore = score
      }
    }
    for (const loser of entries) {
      if (loser !== winner) creates.push({ path: loser.path, content: loser.content, frontmatterDocId: null })
    }

    const finalHash = sha256(winner.content)
    const baseHash = baselineHash.get(docId)!
    const samePath = winner.path === base.path
    const sameContent = finalHash === baseHash
    if (samePath && sameContent) {
      actions.push({ type: "noop", path: base.path, docId })
    } else if (samePath && !sameContent) {
      actions.push({ type: "update", path: base.path, docId, content: winner.content, expectedRevision: base.revision })
    } else if (!samePath && sameContent) {
      actions.push({ type: "move", fromPath: base.path, toPath: winner.path, docId, expectedRevision: base.revision })
    } else {
      actions.push({ type: "moveAndUpdate", fromPath: base.path, toPath: winner.path, docId, content: winner.content, expectedRevision: base.revision })
    }
  }

  // Any baseline doc whose id never reappeared in the final tree is gone —
  // its containing directory disappeared, which per spec means every doc
  // nested under it is gone too (each is its own baseline entry, so each
  // gets its own delete action here). Deepest paths first so a child's
  // deletion is recorded before its parent's.
  const deletes = baseline
    .filter((b) => !groups.has(b.docId))
    .map((b): ReconciliationAction => ({ type: "delete", path: b.path, docId: b.docId, expectedRevision: b.revision }))
    .sort((a, b) => (b.type === "delete" && a.type === "delete" ? b.path.split("/").length - a.path.split("/").length : 0))

  // New paths with no valid id are creates. Top-down by depth so a new
  // parent's doc is created before a new child nested inside it (doc-fs's own
  // implicit parent-chain creation makes this a nicety, not a correctness
  // requirement, but it keeps the plan legible and avoids relying on that).
  const sortedCreates = creates
    .map((c): ReconciliationAction => ({ type: "create", path: c.path, content: c.content }))
    .sort((a, b) => (a.type === "create" && b.type === "create" ? a.path.split("/").length - b.path.split("/").length : 0))

  return [...deletes, ...actions, ...sortedCreates]
}

export type ReconciliationConflict = { path: string; title: string }

export type ReconciliationResult = {
  applied: ReconciliationAction[]
  conflicts: ReconciliationConflict[]
}

/**
 * Applies a reconciliation plan through lib/doc-fs.ts, one action at a time
 * (never in parallel — see the module comment on why sequential application
 * is what makes doc-fs's implicit parent-chain creation converge instead of
 * racing to create the same new directory twice).
 *
 * A revision conflict (a human edited the same doc in the UI mid-turn) is
 * never silently retried or dropped: the agent's would-be content is
 * preserved as a labeled, non-current DocVersion on the doc as it now
 * actually stands, and the conflict is reported back for the turn's final
 * message (spec §2.4).
 */
export async function applyReconciliationPlan(
  workspaceId: string,
  turnId: string,
  actions: readonly ReconciliationAction[],
  authorName: string
): Promise<ReconciliationResult> {
  const applied: ReconciliationAction[] = []
  const conflicts: ReconciliationConflict[] = []

  for (const action of actions) {
    const operationId = docFs.deriveOperationId(turnId, "docId" in action ? action.docId : action.path)
    try {
      switch (action.type) {
        case "noop":
          break
        case "update":
          await docFs.writePath(workspaceId, action.path, action.content, {
            operationId,
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
          })
          break
        case "move":
          await docFs.movePath(workspaceId, action.fromPath, action.toPath, {
            operationId,
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
          })
          break
        case "moveAndUpdate":
          await docFs.movePath(workspaceId, action.fromPath, action.toPath, {
            operationId: docFs.deriveOperationId(operationId, "move"),
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
          })
          await docFs.writePath(workspaceId, action.toPath, action.content, {
            operationId: docFs.deriveOperationId(operationId, "update"),
            authorName,
          })
          break
        case "delete":
          await docFs.deletePath(workspaceId, action.path, {
            operationId,
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
            recursive: true,
          })
          break
        case "create":
          await docFs.writePath(workspaceId, action.path, action.content, { operationId, authorName })
          break
      }
      applied.push(action)
    } catch (error) {
      if (error instanceof DocumentError && error.code === "revision-conflict") {
        const path = "toPath" in action ? action.toPath : action.path
        const content = "content" in action ? action.content : null
        const docId = "docId" in action ? action.docId : null
        if (content !== null && docId) {
          // Record the agent's would-be content as history WITHOUT touching
          // the doc's live state — the live doc keeps the human's concurrent
          // edit (never silently overwritten), and the agent's edit is
          // durably preserved for review/restore (never silently dropped).
          await docFs.recordConflictingSnapshot(docId, content, authorName).catch(() => {
            /* best-effort: the conflict is still reported even if the snapshot write itself fails */
          })
        }
        conflicts.push({ path, title: path.split("/").pop() ?? path })
        continue
      }
      throw error
    }
  }

  return { applied, conflicts }
}
