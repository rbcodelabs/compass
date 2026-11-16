// Reads the agent's final doc tree back out of the sandbox (ADR 0019 §2.4).
// Imported by turn-entry.ts as "./docs-final-state.ts"; the host route writes it
// next to entry.ts. Node only ERASES types from this file at load, so keep it
// free of enums, namespaces and parameter properties.

import type { WikiSession } from "@rbcodelabs/geode-headless/wiki"

export type FinalDocFile = { path: string; frontmatterDocId: string | null; content: string }

export type CollectedDocState = {
  files: FinalDocFile[]
  /** The wiki view was cut short, could not be refreshed, or a discovered note could not be read: absence proves nothing. */
  incomplete: boolean
  /**
   * The re-scan itself failed, so every file below is from a STALE scan and none of it can
   * be trusted, creates and updates included, not just deletes. The caller must not reconcile.
   */
  refreshFailed: boolean
  /** Files left out: invalid doc names, a root-level _doc.md, and notes that are not a doc's _doc.md. */
  skippedNames: string[]
}

export const MAX_DOC_DEPTH = 30
/** Mirrors lib/doc-path.ts validateDocPath's total-length cap. */
export const MAX_DOC_PATH_LENGTH = 4096
// eslint-disable-next-line no-control-regex
const ILLEGAL_SEGMENT_CHARS = /[/\\:*?"<>|$%\x00-\x1f\x7f-\x9f]/

/** Mirrors lib/doc-path.ts validateDocPath, which the server applies again; this one only avoids sending a doomed request. */
export function isValidDocName(docPath: string): boolean {
  if (docPath.length === 0 || docPath.length > MAX_DOC_PATH_LENGTH) return false
  const segments = docPath.split("/")
  if (segments.length > MAX_DOC_DEPTH) return false
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(".") &&
      !segment.startsWith("~") &&
      segment !== "node_modules" &&
      segment !== "_doc.md" &&
      !ILLEGAL_SEGMENT_CHARS.test(segment) &&
      segment === segment.trim() &&
      !/^['`]|['`]$/.test(segment) &&
      !segment.endsWith(".") &&
      Buffer.byteLength(segment, "utf8") <= 200,
  )
}

/**
 * The agent's final doc tree.
 *
 * The session is a SCAN of the folder, not a live view: a file the agent wrote
 * natively (the SDK's Write/Edit tools go straight to disk, not through the
 * session) is invisible to listFiles()/readNote() until `refresh()` re-scans. Only
 * writes made through the session's own methods (the delete_local_doc and
 * move_local_doc tools) update the view as they go. So the scan is refreshed first
 * and a refresh that fails or throws marks the whole state incomplete, which makes
 * the host skip every delete rather than trust a stale view.
 */
export async function collectFinalDocState(session: WikiSession, log: (message: string) => void = () => {}): Promise<CollectedDocState> {
  const files: FinalDocFile[] = []
  const skippedNames: string[] = []
  let incomplete = false
  let refreshFailed = false
  try {
    const refreshed = await session.refresh()
    if (refreshed.status !== "ok") {
      log(`docs session refresh did not succeed: ${JSON.stringify(refreshed).slice(0, 200)}`)
      incomplete = true
      refreshFailed = true
    }
  } catch (error) {
    log(`docs session refresh threw: ${error instanceof Error ? error.message : String(error)}`)
    incomplete = true
    refreshFailed = true
  }
  const info = session.info()
  // False when a limit (entries, depth, bytes) cut the walk short or a note's bytes
  // could not be read; either way a missing doc is not proof it was removed.
  if (!info.discoveryComplete || !info.noteContentComplete) incomplete = true
  for (const entry of session.listFiles()) {
    if (entry.kind !== "note") continue
    // A doc is a directory holding exactly one _doc.md. A root-level _doc.md has no doc to belong
    // to, and any other note (Product/notes.md) is not one at all: tell the user instead of dropping them silently.
    if (entry.path === "_doc.md" || !entry.path.endsWith("/_doc.md")) {
      skippedNames.push(entry.path)
      continue
    }
    const docPath = entry.path.slice(0, -"/_doc.md".length)
    const read = session.readNote(entry.path)
    if (read.status !== "ok") {
      // An unreadable note must not look like a deletion, so the whole state is marked incomplete.
      log(`could not read "${entry.path}" for final doc state: ${read.reason}`)
      incomplete = true
      continue
    }
    if (!isValidDocName(docPath)) {
      skippedNames.push(docPath)
      continue
    }
    const frontmatter = read.note.metadata?.frontmatter
    const frontmatterDocId = frontmatter && typeof frontmatter.compass_doc_id === "string" ? frontmatter.compass_doc_id : null
    files.push({ path: docPath, content: read.note.text, frontmatterDocId })
  }
  return { files, incomplete, refreshFailed, skippedNames }
}

// ── Handing the final state to Compass ──────────────────────────────────────

export type DocsReconcileOutcome =
  | { kind: "ok"; notice: string | null }
  /** 403 AGENT_READ_ONLY: a named agent with only a READ grant ran, so nothing it edited was applied. Retrying cannot help. */
  | { kind: "read-only" }
  | { kind: "failed"; detail: string }

export type DocsReconcilePost = { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } }

const RECONCILE_ATTEMPTS = 3
const RECONCILE_RETRY_DELAYS_MS = [500, 1500]

/**
 * POSTs the final doc state. A network error or a 5xx is retried (up to three attempts), because the reconcile is idempotent: every doc
 * action carries an operation id derived from the run and the doc, so a replay of a pass that already landed reports no conflict
 * (__tests__/agent-docs-callback-replay.test.ts). Any 4xx is final: the request itself was refused and a retry would be refused again.
 * Never throws.
 */
export async function postDocsReconcile(
  post: DocsReconcilePost,
  deps: { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; delaysMs?: number[] } = {},
): Promise<DocsReconcileOutcome> {
  const fetcher = deps.fetcher ?? fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const delays = deps.delaysMs ?? RECONCILE_RETRY_DELAYS_MS
  let detail = "no attempt was made"
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0)
    try {
      const response = await fetcher(post.url, post.init)
      if (response.ok) {
        const result = (await response.json().catch(() => ({}))) as { notice?: string | null }
        return { kind: "ok", notice: result.notice ?? null }
      }
      if (response.status >= 500) {
        detail = `docs reconciliation returned ${response.status}`
        continue
      }
      const body = (await response.json().catch(() => ({}))) as { code?: string }
      if (response.status === 403 && body.code === "AGENT_READ_ONLY") return { kind: "read-only" }
      return { kind: "failed", detail: `docs reconciliation returned ${response.status}${body.code ? ` (${body.code})` : ""}` }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
  }
  return { kind: "failed", detail: `${detail} (after ${RECONCILE_ATTEMPTS} attempts)` }
}
