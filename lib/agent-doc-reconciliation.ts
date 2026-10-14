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
import { validateDocPath } from "@/lib/doc-path"

/**
 * Either `content` or `contentSha256` identifies what a file held. The
 * synchronous turn path has full content on both sides; the detached path only
 * has a signed hash manifest for the baseline, and the sandbox sends content
 * for a final file only when it differs from that baseline (otherwise just the
 * hash), so a large unchanged tree never crosses the callback.
 */
export type DocBaselineEntry = { path: string; docId: string; revision: string | null; content?: string; contentSha256?: string }
export type DocFinalFile = { path: string; frontmatterDocId: string | null; content?: string; contentSha256?: string }

export type ReconciliationAction =
  | { type: "noop"; path: string; docId: string }
  | { type: "update"; path: string; docId: string; content: string; expectedRevision: string | null }
  | { type: "move"; fromPath: string; toPath: string; docId: string; expectedRevision: string | null }
  | { type: "moveAndUpdate"; fromPath: string; toPath: string; docId: string; content: string; expectedRevision: string | null }
  | { type: "delete"; path: string; docId: string; expectedRevision: string | null }
  | { type: "create"; path: string; content: string }

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function hashOf(entry: { content?: string; contentSha256?: string }): string {
  if (entry.contentSha256) return entry.contentSha256
  if (entry.content !== undefined) return sha256(entry.content)
  throw new Error("Doc entry carries neither content nor a content hash")
}

/** An action that writes needs real bytes; a hash alone must never become an empty overwrite. */
function contentOf(entry: { path: string; content?: string }): string {
  if (entry.content === undefined) throw new Error(`Doc "${entry.path}" changed but no content was provided`)
  return entry.content
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
  const baselineHash = new Map(baseline.map((b) => [b.docId, hashOf(b)]))

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
      if (loser !== winner) creates.push({ path: loser.path, content: contentOf(loser), frontmatterDocId: null })
    }

    const finalHash = hashOf(winner)
    const baseHash = baselineHash.get(docId)!
    const samePath = winner.path === base.path
    const sameContent = finalHash === baseHash
    if (samePath && sameContent) {
      actions.push({ type: "noop", path: base.path, docId })
    } else if (samePath && !sameContent) {
      actions.push({ type: "update", path: base.path, docId, content: contentOf(winner), expectedRevision: base.revision })
    } else if (!samePath && sameContent) {
      actions.push({ type: "move", fromPath: base.path, toPath: winner.path, docId, expectedRevision: base.revision })
    } else {
      actions.push({ type: "moveAndUpdate", fromPath: base.path, toPath: winner.path, docId, content: contentOf(winner), expectedRevision: base.revision })
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
    .map((c): ReconciliationAction => ({ type: "create", path: c.path, content: contentOf(c) }))
    .sort((a, b) => (a.type === "create" && b.type === "create" ? a.path.split("/").length - b.path.split("/").length : 0))

  // Order matters because every action addresses its doc by id but names its
  // destination by path: moves first, parents before children, so a later move
  // or create can land under a directory an earlier move just produced; deletes
  // after moves so a child moved out of a deleted parent no longer blocks it;
  // creates last, top-down, so they can nest under anything that now exists.
  const depth = (path: string) => path.split("/").length
  const moves = actions
    .filter((a) => a.type === "move" || a.type === "moveAndUpdate")
    .sort((a, b) => (a.type === "move" || a.type === "moveAndUpdate") && (b.type === "move" || b.type === "moveAndUpdate") ? depth(a.toPath) - depth(b.toPath) : 0)
  const rest = actions.filter((a) => a.type !== "move" && a.type !== "moveAndUpdate")
  return [...moves, ...rest, ...deletes, ...sortedCreates]
}

/** Reconciliation inputs beyond the file list: what the sandbox could and could not see, and what it deleted on purpose. */
export type DocFinalState = {
  files: DocFinalFile[]
  /** The sandbox's wiki view was cut short or a note could not be read: absence proves nothing. */
  incomplete?: boolean
  /** Doc paths the agent removed through delete_local_doc. Anything else missing from `files` is not a deletion. */
  deletedPaths?: string[]
}

/** Above this many explicit deletes AND above half the baseline, nothing is deleted without a human looking. */
export const MAX_UNREVIEWED_DELETES = 10

/**
 * Fail-closed filter for delete actions. A baseline doc that merely vanished
 * from the final tree (unreadable, past a walk limit, hidden by a name the wiki
 * skips) is indistinguishable from a deleted one by file comparison alone, and a
 * hard delete cascades to comments and history. So a delete runs only when the
 * agent explicitly removed that doc, the sandbox's view was complete, and the
 * count is not an implausible share of the workspace.
 */
export function guardDeletes(
  plan: readonly ReconciliationAction[],
  baselineSize: number,
  state: Pick<DocFinalState, "incomplete" | "deletedPaths">
): { plan: ReconciliationAction[]; skipped: { path: string; reason: "incomplete" | "not-requested" | "too-many" }[] } {
  const explicit = new Set(state.deletedPaths ?? [])
  const skipped: { path: string; reason: "incomplete" | "not-requested" | "too-many" }[] = []
  let allowed = plan.filter((a): a is Extract<ReconciliationAction, { type: "delete" }> => {
    if (a.type !== "delete") return false
    // Fail closed: only an explicit `false` means "complete".
    if (state.incomplete !== false) { skipped.push({ path: a.path, reason: "incomplete" }); return false }
    if (!explicit.has(a.path)) { skipped.push({ path: a.path, reason: "not-requested" }); return false }
    return true
  })
  if (allowed.length > MAX_UNREVIEWED_DELETES && allowed.length > baselineSize / 2) {
    for (const a of allowed) skipped.push({ path: a.path, reason: "too-many" })
    allowed = []
  }
  const kept = new Set<ReconciliationAction>(allowed)
  return { plan: plan.filter((a) => a.type !== "delete" || kept.has(a)), skipped }
}

export type ConflictReason = "revision" | "operation" | "has-children" | "exists" | "gone" | "invalid" | "failed"

export type ReconciliationConflict = { path: string; title: string; reason: ConflictReason; detail?: string }

export type ReconciliationResult = {
  applied: ReconciliationAction[]
  conflicts: ReconciliationConflict[]
}

/** Duck-typed so this module does not need a runtime import of DocFsError from doc-fs. */
function isDocFsError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === "DocFsError" && typeof (error as { code?: unknown }).code === "string"
}

function classify(error: unknown): { reason: ConflictReason; detail?: string } | null {
  if (error instanceof DocumentError) {
    switch (error.code) {
      case "revision-conflict": return { reason: "revision" }
      case "operation-conflict": return { reason: "operation" }
      case "has-children": return { reason: "has-children" }
      case "not-found": return { reason: "gone" }
      default: return { reason: "invalid", detail: error.code }
    }
  }
  if (isDocFsError(error)) {
    switch (error.code) {
      case "has-children": return { reason: "has-children" }
      case "exists": return { reason: "exists" }
      case "not-found": return { reason: "gone" }
      default: return { reason: "invalid", detail: error.code }
    }
  }
  return null
}

/**
 * Applies a reconciliation plan through lib/doc-fs.ts, one action at a time
 * (never in parallel — sequential application is what makes doc-fs's implicit
 * parent-chain creation converge instead of racing to create the same new
 * directory twice).
 *
 * Actions address docs by id, never by baseline path: an earlier action in the
 * same pass may have renamed or reparented an ancestor, which would leave a
 * baseline path pointing at nothing. Deletes are single-doc and non-recursive,
 * so a child whose delete was refused is never swept away by its parent's.
 *
 * Every per-action doc-level failure (revision or operation conflict, a parent
 * that still has children, a path that is already taken, a doc a human deleted
 * meanwhile) is recorded as a conflict and the pass CONTINUES. The agent's
 * would-be content is preserved as a labeled, non-current DocVersion where a doc
 * exists to hang it on, so nothing is silently dropped and nothing live is
 * silently overwritten (spec §2.4). Anything that is not a doc-level failure
 * (database down, a bug) still throws.
 */
export async function applyReconciliationPlan(
  workspaceId: string,
  turnId: string,
  actions: readonly ReconciliationAction[],
  authorName: string,
  options: { baselineDocIds?: ReadonlySet<string> } = {}
): Promise<ReconciliationResult> {
  // A move may land on a path held by a doc that is itself part of this pass.
  const occupantMayLeave = options.baselineDocIds
  const applied: ReconciliationAction[] = []
  const conflicts: ReconciliationConflict[] = []

  for (const action of actions) {
    const operationId = docFs.deriveOperationId(turnId, "docId" in action ? action.docId : action.path)
    const destination = "toPath" in action ? action.toPath : action.path
    try {
      if ("expectedRevision" in action && action.expectedRevision === null) {
        // No revision to pin means no way to prove the doc is unchanged: refuse.
        throw new DocumentError("revision-conflict")
      }
      switch (action.type) {
        case "noop":
          break
        case "update":
          await docFs.writeDocById(workspaceId, action.docId, action.content, {
            operationId,
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
          })
          break
        case "move":
          await docFs.moveDocById(workspaceId, action.docId, action.toPath, {
            operationId,
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
            occupantMayLeave,
          })
          break
        case "moveAndUpdate": {
          const moved = await docFs.moveDocById(workspaceId, action.docId, action.toPath, {
            operationId: docFs.deriveOperationId(operationId, "move"),
            expectedRevision: action.expectedRevision ?? undefined,
            authorName,
            occupantMayLeave,
          })
          // The move bumped the revision; the content write pins the one it produced.
          await docFs.writeDocById(workspaceId, action.docId, action.content, {
            operationId: docFs.deriveOperationId(operationId, "update"),
            expectedRevision: moved.revision ?? action.expectedRevision ?? undefined,
            authorName,
          })
          break
        }
        case "delete":
          try {
            await docFs.deleteDocById(workspaceId, action.docId, {
              operationId,
              expectedRevision: action.expectedRevision ?? undefined,
              authorName,
            })
          } catch (error) {
            // Already gone (a human, or a replay of this same pass): the goal state holds.
            if (!(isDocFsError(error) && error.code === "not-found") && !(error instanceof DocumentError && error.code === "not-found")) throw error
          }
          break
        case "create":
          await docFs.createPath(workspaceId, action.path, action.content, { operationId, authorName })
          break
      }
      applied.push(action)
    } catch (error) {
      // Anything that is not a doc-level failure (a database write conflict, a
      // dropped connection) is still one action's failure: record it and carry on,
      // so one bad write cannot strand the rest of the pass half-reported.
      let kind = classify(error)
      if (!kind) {
        console.error("[agent-doc-reconciliation] action failed", { type: action.type, path: destination, error })
        kind = { reason: "failed" }
      }
      const content = "content" in action ? action.content : null
      let docId = "docId" in action ? action.docId : null
      if (action.type === "create" && kind.reason === "exists") docId = (await docFs.resolvePath(workspaceId, action.path).catch(() => null))?.docId ?? null
      if (content !== null && docId && (kind.reason === "revision" || kind.reason === "operation" || kind.reason === "exists")) {
        // Record the agent's would-be content as history WITHOUT touching
        // the doc's live state — the live doc keeps the concurrent edit
        // (never silently overwritten), and the agent's edit is durably
        // preserved for review/restore (never silently dropped).
        await docFs.recordConflictingSnapshot(docId, content, authorName).catch(() => {
          /* best-effort: the conflict is still reported even if the snapshot write itself fails */
        })
      }
      conflicts.push({ path: destination, title: destination.split("/").pop() ?? destination, reason: kind.reason, ...(kind.detail ? { detail: kind.detail } : {}) })
    }
  }

  return { applied, conflicts }
}

/** One sentence per outcome the user can act on; shared by the callback and the synchronous route. */
export function describeConflict(c: ReconciliationConflict): string {
  switch (c.reason) {
    case "revision":
    case "operation":
      return `Couldn't save changes to '${c.title}' — someone else edited it while I was working; your edit is saved in its version history for you to review or restore.`
    case "exists":
      return `Couldn't save '${c.title}' — a doc already exists at that path, so I left it alone; anything I wrote for it is in that doc's version history.`
    case "has-children":
      return `Didn't delete '${c.title}' — it still contains docs that were not deleted.`
    case "gone":
      return `Couldn't update '${c.title}' — it was deleted while I was working.`
    case "failed":
      return `Couldn't save '${c.title}' because of an unexpected error; please check it.`
    default:
      return `Couldn't apply my change to '${c.title}'${c.detail ? ` (${c.detail})` : ""}.`
  }
}

export function describeSkippedDeletes(skipped: readonly { path: string; reason: "incomplete" | "not-requested" | "too-many" }[]): string | null {
  if (skipped.length === 0) return null
  const titles = skipped.slice(0, 5).map((s) => `'${s.path.split("/").pop()}'`).join(", ") + (skipped.length > 5 ? `, and ${skipped.length - 5} more` : "")
  const reasons = new Set(skipped.map((s) => s.reason))
  if (reasons.has("incomplete")) return `My working copy of the docs was incomplete, so I did not delete anything (${titles} left in place).`
  if (reasons.has("too-many")) return `That would delete ${skipped.length} docs at once, so I did not delete any of them; ask again to confirm (${titles} left in place).`
  return `${skipped.length} doc${skipped.length === 1 ? " was" : "s were"} missing from my working copy but not deleted on purpose, so ${skipped.length === 1 ? "it was" : "they were"} left in place: ${titles}.`
}

export type ReconcileOutcome = { applied: number; conflicts: ReconciliationConflict[]; notices: string[] }

/**
 * The one entry point both reconciliation paths call (the detached callback and
 * the synchronous route): plan, fail-closed delete filtering, apply, and the
 * user-facing notices.
 */
export async function reconcileAgentDocs(
  workspaceId: string,
  turnId: string,
  baseline: readonly DocBaselineEntry[],
  state: DocFinalState,
  authorName: string
): Promise<ReconcileOutcome> {
  const planned = planReconciliation(baseline, state.files)
  const { plan, skipped } = guardDeletes(planned, baseline.length, state)
  const { applied, conflicts } = await applyReconciliationPlan(workspaceId, turnId, plan, authorName, {
    baselineDocIds: new Set(baseline.map((b) => b.docId)),
  })
  const notices = [...conflicts.map(describeConflict)]
  const skippedNotice = describeSkippedDeletes(skipped)
  if (skippedNotice) notices.push(skippedNotice)
  return { applied: applied.filter((a) => a.type !== "noop").length, conflicts, notices }
}

/** Most files a final state may carry: the wiki walk stops at 10,000 entries (a file and a directory per doc), plus headroom. */
export const MAX_FINAL_FILES = 5_900

/**
 * Validates untrusted final-state JSON from the synchronous path (stdout of a
 * sandbox that runs agent-controlled code) with the same rules the detached
 * callback applies. Files with an invalid path or no content are dropped and
 * counted; invalid or excess deletedPaths are dropped silently (they can only
 * narrow what gets deleted); anything but an explicit `incomplete: false` stays
 * incomplete, so a malformed or older-format payload can never enable a delete.
 */
export function coerceFinalState(raw: unknown): { state: DocFinalState; rejectedFiles: number } {
  const obj = (Array.isArray(raw) ? { files: raw } : raw ?? {}) as { files?: unknown; incomplete?: unknown; deletedPaths?: unknown }
  const files: DocFinalFile[] = []
  let rejectedFiles = 0
  const seen = new Set<string>()
  for (const item of Array.isArray(obj.files) ? obj.files : []) {
    const f = (item ?? {}) as { path?: unknown; content?: unknown; frontmatterDocId?: unknown }
    if (
      typeof f.path !== "string" || validateDocPath(f.path) !== null || seen.has(f.path) || typeof f.content !== "string" ||
      (f.frontmatterDocId !== null && f.frontmatterDocId !== undefined && typeof f.frontmatterDocId !== "string") ||
      files.length >= MAX_FINAL_FILES
    ) {
      rejectedFiles++
      continue
    }
    seen.add(f.path)
    files.push({ path: f.path, content: f.content, frontmatterDocId: (f.frontmatterDocId as string | null | undefined) ?? null })
  }
  const deletedPaths = [
    ...new Set((Array.isArray(obj.deletedPaths) ? obj.deletedPaths : []).filter((p): p is string => typeof p === "string" && validateDocPath(p) === null)),
  ].slice(0, MAX_FINAL_FILES)
  return { state: { files, incomplete: obj.incomplete !== false, deletedPaths }, rejectedFiles }
}
