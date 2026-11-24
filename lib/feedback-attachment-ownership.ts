import { Prisma } from "@prisma/client"
import { after } from "next/server"
import type { AppPrismaClient } from "@/lib/db"
import { configuredBlobStoreHostname } from "@/lib/feedback-attachments"
import { compassEnv } from "@/lib/runtime-env"
import { getActiveSchema } from "@/lib/schema"
import { getPublicFileStore } from "@/lib/storage/public-store"

/**
 * Ownership and guarded release of feedback-attachment files in the public store.
 *
 * Deleting a workspace's feedback rows (admin purge, workspace/organization/account teardown) used to leave the files behind on
 * public URLs forever. This module is the ONLY deleter. A deleted file cannot be restored, and the same file can be referenced by
 * rows in other workspaces (legacy import sharing), so every delete passes every guard below, and anything doubtful is kept:
 *
 *   1. ownership: only `feedback/<this workspace's UUID>/<name>` on the configured store host (parseOwnedFeedbackKey);
 *   2. reference scan: a key still named by ANY attachment row, in any workspace, is kept (findReferencedFeedbackKeys);
 *   3. after commit: callers invoke this only once the row delete has committed;
 *   4. skipBlobCleanup (preview automation) deletes nothing;
 *   5. a wall-clock budget with bounded concurrency; whatever is not deleted is logged, in chunks, as the only retry record;
 *   6. nothing is owned while the Blob store is unconfigured;
 *   7. only when compassEnv() is "production" AND FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED is exactly "1" (read at call time);
 *      otherwise the whole path runs and only logs "would delete".
 *
 * Design: Products/Compass/Runs/compass-attachment-leak-small-fix-design.md (revision 3).
 */

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const FILENAME = "[A-Za-z0-9._-]{1,300}"
const RELEASE_BUDGET_MS = 20_000
const RELEASE_CONCURRENCY = 5
const LOG_CHUNK = 50
const LOG_TAG = "[feedback-attachment-release]"

/**
 * The pathname (no leading slash) of a feedback attachment URL this deployment handed out for `workspaceId`, or null. Strict and
 * case-sensitive on purpose: null means "never delete". `workspaceId` must itself be a lowercase UUID (as the database returns it).
 */
export function parseOwnedFeedbackKey(url: unknown, workspaceId: string): string | null {
  if (typeof url !== "string" || !url || !WORKSPACE_ID.test(workspaceId)) return null
  // A URL parser normalizes `..`, `\` and encodings away, so refuse them in the raw text first.
  if (/%2e|%2f|%5c|%00/i.test(url) || url.includes("\\") || /[?#]/.test(url)) return null
  // Whitespace and control characters: a URL parser silently trims or strips them, so the string would not be the one stored.
  if (/[\u0000-\u0020\u007f-\u009f]/.test(url)) return null
  if (url.split("/").some((segment) => segment === "." || segment === "..")) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null
    if (parsed.search || parsed.hash) return null
    if (parsed.hostname !== configuredBlobStoreHostname()) return null
    if (!new RegExp(`^/feedback/${workspaceId}/${FILENAME}$`).test(parsed.pathname)) return null
    return parsed.pathname.slice(1)
  } catch {
    return null
  }
}

/** `"<schema>"."feedback_attachment"` for the active schema, so dev, preview and production resolve. Refuses anything needing escaping. */
export function feedbackAttachmentTable(): Prisma.Sql {
  const schema = getActiveSchema()
  if (!/^[A-Za-z0-9_]+$/.test(schema)) throw new Error("Unexpected schema name")
  return Prisma.raw(`"${schema}"."feedback_attachment"`)
}

/**
 * Which of `keys` (all under `feedback/<workspaceId>/`) is still named by some attachment row, in any workspace. ONE query: a
 * bound-parameter ILIKE on the workspace UUID, then each returned row is canonicalized here (decoded once when it contains `%`,
 * query and fragment dropped, pathnames compared lowercased). A matching row that cannot be decoded or parsed could be naming any
 * key, so it counts as a reference to every key. Variants that hide the UUID itself behind percent-encoding are not matched by the
 * ILIKE (accepted gap; see the design note, section g). Throws on a database error: the caller fails closed.
 */
export async function findReferencedFeedbackKeys(prisma: AppPrismaClient, workspaceId: string, keys: readonly string[]): Promise<Set<string>> {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error("Workspace id is not a lowercase UUID")
  const rows = await prisma.$queryRaw<{ id: string; url: string }[]>(
    Prisma.sql`SELECT id, url FROM ${feedbackAttachmentTable()} WHERE url ILIKE '%' || ${workspaceId}::text || '%'`,
  )
  const referenced = new Set<string>()
  const wanted = new Map(keys.map((key) => [key.toLowerCase(), key]))
  for (const row of rows) {
    let pathname: string | null = null
    try {
      const raw = String(row.url)
      pathname = new URL(raw.includes("%") ? decodeURIComponent(raw) : raw).pathname.slice(1).toLowerCase()
    } catch {
      // Cannot attribute the row to one key, so it protects them all.
      for (const key of keys) referenced.add(key)
      continue
    }
    const key = wanted.get(pathname)
    if (key !== undefined) referenced.add(key)
  }
  return referenced
}

/** One wall-clock budget, shared by every release it is passed to (account deletion releases many workspaces under one). */
export type ReleaseBudget = {
  readonly ms: number
  readonly now: () => number
  /** Fixed when the first release starts, so database work before it is not charged to the budget. */
  deadline: number | null
  /** Releases sharing a budget run one after another, so the concurrency bound is global. */
  tail: Promise<unknown>
}

export function createReleaseBudget(ms: number = RELEASE_BUDGET_MS, now: () => number = Date.now): ReleaseBudget {
  return { ms, now, deadline: null, tail: Promise.resolve() }
}

export type ReleaseResult = {
  /** Files actually removed from the store. */
  deleted: number
  /** Files deliberately left: not this workspace's, or still referenced. */
  kept: number
  /** Files that would have been deleted with the flag on (dry run). */
  dryRun: number
  /** Files that should have been deleted but were not (provider failure, budget): leaked, listed in the warn lines. */
  failed: number
}

export type ReleaseOptions = { skipBlobCleanup?: boolean; budget?: ReleaseBudget; now?: () => number }

const EMPTY: ReleaseResult = { deleted: 0, kept: 0, dryRun: 0, failed: 0 }

function isProduction(): boolean {
  try {
    return compassEnv() === "production"
  } catch {
    return false
  }
}

/** Logs `pathnames` as `console[level]` lines of at most LOG_CHUNK each, every line carrying the workspace id, chunk index and total. */
function logChunks(level: "warn" | "info", message: string, workspaceId: string, pathnames: readonly string[]): void {
  const chunks = Math.max(1, Math.ceil(pathnames.length / LOG_CHUNK))
  for (let i = 0; i < pathnames.length; i += LOG_CHUNK) {
    console[level](LOG_TAG, JSON.stringify({ message, workspaceId, chunk: i / LOG_CHUNK + 1, chunks, total: pathnames.length, pathnames: pathnames.slice(i, i + LOG_CHUNK) }))
  }
}

/**
 * Releases the files behind `urls` (the attachment URLs of rows that were just deleted and whose delete has COMMITTED) for
 * `workspaceId`. Never throws: any failure is logged and the files are kept or leaked, never half-trusted.
 */
export async function releaseOwnedFeedbackBlobs(
  prisma: AppPrismaClient,
  workspaceId: string,
  urls: readonly string[],
  options: ReleaseOptions = {},
): Promise<ReleaseResult> {
  if (options.skipBlobCleanup || !isProduction() || urls.length === 0) return { ...EMPTY }
  const budget = options.budget ?? createReleaseBudget(RELEASE_BUDGET_MS, options.now)
  const run = budget.tail.then(() => releaseNow(prisma, workspaceId, urls, budget))
  budget.tail = run.catch(() => undefined)
  return run.catch((error) => {
    safeWarn(workspaceId, "release failed", error)
    return { ...EMPTY }
  })
}

function safeWarn(workspaceId: string, message: string, error: unknown): void {
  try {
    console.warn(LOG_TAG, JSON.stringify({ message, workspaceId, error: error instanceof Error ? error.message : String(error) }))
  } catch {
    // The logger itself must never break a purge or teardown.
  }
}

async function releaseNow(prisma: AppPrismaClient, workspaceId: string, urls: readonly string[], budget: ReleaseBudget): Promise<ReleaseResult> {
  const now = budget.now
  const result: ReleaseResult = { ...EMPTY }
  // Ownership: only this workspace's own keys, once each.
  const owned = new Map<string, string>()
  for (const url of new Set(urls)) {
    const key = parseOwnedFeedbackKey(url, workspaceId)
    // The provider is handed the canonical URL built from the validated key, never the raw stored string.
    if (key !== null) owned.set(key, `https://${configuredBlobStoreHostname()}/${key}`)
  }
  result.kept += new Set(urls).size - owned.size
  if (owned.size === 0) return result

  // The deadline starts here, so the scan is inside the budget. Once it has passed (earlier workspaces of an account or organization
  // deletion used it up) nothing is scanned or deleted; the leftover pathnames are logged as the only record.
  budget.deadline ??= now() + budget.ms
  if (now() >= budget.deadline) {
    result.failed = owned.size
    logChunks("warn", "budget exhausted before the reference scan; files not deleted; leaked", workspaceId, [...owned.keys()].sort())
    return result
  }

  // Reference scan: fail closed on any error.
  let referenced: Set<string>
  try {
    referenced = await findReferencedFeedbackKeys(prisma, workspaceId, [...owned.keys()])
  } catch (error) {
    safeWarn(workspaceId, "reference scan failed; nothing deleted", error)
    result.kept += owned.size
    return result
  }
  const candidates = [...owned].filter(([key]) => !referenced.has(key))
  result.kept += owned.size - candidates.length
  if (candidates.length === 0) return result

  // Flag: exactly "1", read now. Off means a dry run that only logs.
  if (process.env.FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED !== "1") {
    try {
      logChunks("info", "would delete (dry run; FEEDBACK_ATTACHMENT_BLOB_DELETE_ENABLED is not 1)", workspaceId, candidates.map(([key]) => key))
    } catch {
      // Dry-run logging must never break the caller.
    }
    result.dryRun = candidates.length
    return result
  }

  // Delete: bounded concurrency inside one wall-clock budget; one delete per object, each isolated.
  const deadline = budget.deadline ?? now() + budget.ms
  const store = getPublicFileStore()
  const leaked: string[] = []
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= candidates.length) return
      const [key, url] = candidates[index]
      if (now() >= deadline) {
        leaked.push(key)
        continue
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("delete timed out")), Math.max(1, deadline - now()))
        })
        await Promise.race([store.delete([url]), timeout])
        result.deleted++
      } catch {
        leaked.push(key)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RELEASE_CONCURRENCY, candidates.length) }, worker))
  result.failed = leaked.length
  if (leaked.length > 0) {
    try {
      logChunks("warn", "files not deleted; leaked (no retry record exists besides these lines)", workspaceId, leaked.sort())
    } catch {
      // see safeWarn
    }
  }
  return result
}

/**
 * Release after the response is sent (teardown paths), falling back to inline when `after()` has no request scope (scripts, tests).
 * The returned promise settles when the work does inline, and immediately when it was handed to after().
 */
export function releaseOwnedFeedbackBlobsAfterResponse(
  prisma: AppPrismaClient,
  workspaceId: string,
  urls: readonly string[],
  options: ReleaseOptions = {},
): Promise<void> {
  if (options.skipBlobCleanup || urls.length === 0) return Promise.resolve()
  const work = async () => {
    await releaseOwnedFeedbackBlobs(prisma, workspaceId, urls, options)
  }
  try {
    after(work)
    return Promise.resolve()
  } catch {
    return work()
  }
}
