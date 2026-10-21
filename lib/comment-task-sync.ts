/**
 * Task status -> Doc comment thread sync.
 *
 * A Task created from a Doc comment is linked to that comment by a TaskLink
 * (linkedType "COMMENT"). When the task becomes DONE the thread it belongs to is
 * resolved; when a DONE task is reopened the thread is reopened.
 *
 * The sync is one-directional by construction: it only writes the comment
 * thread's status and never touches a Task, so resolving or reopening a thread
 * by hand cannot bounce back into the task and there is no loop to guard.
 *
 * Concurrency: the triggering write's from/to is only a hint that "a DONE
 * boundary was crossed". Two quick flips (DONE then TODO) run their syncs in
 * arbitrary order, so trusting each one's own `to` lets the stale one win. The
 * sync therefore (1) runs one at a time per task inside this process and (2)
 * decides from the task's CURRENT status, re-checking after it writes and
 * repeating until the thread matches. Across separate server instances the
 * mutex cannot help, but the re-check loop still converges.
 *
 * Hooked from captureWorkspaceMutation, the single choke point every Task status
 * write already goes through (UI, MCP, REST), so no caller has to remember it.
 */
import getPrisma from "@/lib/db"
import { setDocCommentStatusCore, type CommentStatus } from "@/lib/doc-comments"

/** A task in one of these states no longer holds a thread open. */
const FINISHED = ["DONE", "CANCELLED"]
const MAX_PASSES = 4

/** Whether a status transition crosses the DONE boundary (the only thing that touches threads). */
export function transitionTouchesThreads(from: string | null | undefined, to: string): boolean {
  return from !== to && (to === "DONE" || from === "DONE")
}

/** The thread status a task in `status` asks for, or null when it asks for nothing (CANCELLED). */
export function threadStatusForTaskStatus(status: string): CommentStatus | null {
  if (status === "DONE") return "RESOLVED"
  if (status === "CANCELLED") return null
  return "OPEN"
}

export interface ThreadSyncResult {
  resolved: string[]
  reopened: string[]
}

// One chain per task so overlapping syncs run in order, not interleaved.
const chains = new Map<string, Promise<unknown>>()

function serialize<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(taskId) ?? Promise.resolve()
  const next = previous.then(work, work)
  chains.set(taskId, next)
  void next.finally(() => { if (chains.get(taskId) === next) chains.delete(taskId) }).catch(() => undefined)
  return next
}

/**
 * Apply a task status transition to the threads of its linked comments. Never
 * throws: a sync problem must not fail the task edit that triggered it.
 */
export function syncCommentThreadsForTaskStatus(
  taskId: string,
  from: string | null | undefined,
  to: string,
): Promise<ThreadSyncResult> {
  if (!transitionTouchesThreads(from, to)) return Promise.resolve({ resolved: [], reopened: [] })
  return reconcileCommentThreadsForTask(taskId)
}

/** Bring the task's comment threads in line with its CURRENT status, one task at a time. */
export function reconcileCommentThreadsForTask(taskId: string): Promise<ThreadSyncResult> {
  return serialize(taskId, () => reconcile(taskId))
}

async function reconcile(taskId: string): Promise<ThreadSyncResult> {
  const result: ThreadSyncResult = { resolved: [], reopened: [] }
  try {
    const prisma = getPrisma()
    // Stays on task_links (not the TASK read flip): COMMENT links are legacy-only by design and never mirrored to entity_links.
    const links = await prisma.taskLink.findMany({ where: { taskId, linkedType: "COMMENT" }, select: { linkedId: true } })
    if (links.length === 0) return result
    const linked = await prisma.docComment.findMany({
      where: { id: { in: links.map(link => link.linkedId) } },
      select: { id: true, parentId: true },
    })
    const rootIds = [...new Set(linked.map(comment => comment.parentId ?? comment.id))]

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } })
      if (!task) return result
      const seen = task.status
      const wanted = threadStatusForTaskStatus(seen)
      if (!wanted) return result

      for (const rootId of rootIds) {
        const root = await prisma.docComment.findUnique({ where: { id: rootId }, select: { id: true, status: true } })
        if (!root || root.status === wanted) continue // idempotent: already converged

        if (wanted === "RESOLVED") {
          // One thread can carry several tasks (the root and a reply each made one).
          // Only resolve once none of the others is still live.
          const threadIds = [rootId, ...(await prisma.docComment.findMany({ where: { parentId: rootId }, select: { id: true } })).map(reply => reply.id)]
          const stillOpen = await prisma.task.count({
            where: {
              id: { not: taskId },
              status: { notIn: FINISHED },
              links: { some: { linkedType: "COMMENT", linkedId: { in: threadIds } } },
            },
          })
          if (stillOpen > 0) continue
        }

        const updated = await setDocCommentStatusCore(rootId, wanted)
        if (updated) (wanted === "RESOLVED" ? result.resolved : result.reopened).push(rootId)
      }

      // The task may have flipped while we wrote; go again until its status holds still.
      const after = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } })
      if (!after || after.status === seen) break
    }
  } catch (error) {
    console.error("[comment-task-sync] could not sync thread", { taskId }, error)
  }
  return result
}
