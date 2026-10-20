/**
 * Task status -> Doc comment thread sync.
 *
 * A Task created from a Doc comment is linked to that comment by a TaskLink
 * (linkedType "COMMENT"). When the task becomes DONE the thread it belongs to is
 * resolved; when a DONE task is reopened the thread is reopened.
 *
 * The sync is one-directional by construction: it only writes the comment
 * thread's status and never touches a Task, so resolving or reopening a thread
 * by hand cannot bounce back into the task and there is no loop to guard. It is
 * idempotent (a write happens only when the thread is not already in the wanted
 * state), so replays and two near-simultaneous status changes converge.
 *
 * Hooked from captureWorkspaceMutation, the single choke point every Task status
 * write already goes through (UI, MCP, REST), so no caller has to remember it.
 */
import getPrisma from "@/lib/db"
import { setDocCommentStatusCore, type CommentStatus } from "@/lib/doc-comments"

/** A task in one of these states no longer holds a thread open. */
const FINISHED = ["DONE", "CANCELLED"]

/** The thread status a status transition asks for, or null when the transition says nothing. */
export function threadStatusForTransition(from: string | null | undefined, to: string): CommentStatus | null {
  if (to === from) return null
  if (to === "DONE") return "RESOLVED"
  // Leaving DONE for live work reopens. DONE -> CANCELLED leaves the thread as it was.
  if (from === "DONE" && !FINISHED.includes(to)) return "OPEN"
  return null
}

export interface ThreadSyncResult {
  resolved: string[]
  reopened: string[]
}

/**
 * Apply a task status transition to the threads of its linked comments. Never
 * throws: a sync problem must not fail the task edit that triggered it.
 */
export async function syncCommentThreadsForTaskStatus(
  taskId: string,
  from: string | null | undefined,
  to: string,
): Promise<ThreadSyncResult> {
  const result: ThreadSyncResult = { resolved: [], reopened: [] }
  const wanted = threadStatusForTransition(from, to)
  if (!wanted) return result
  try {
    const prisma = getPrisma()
    const links = await prisma.taskLink.findMany({ where: { taskId, linkedType: "COMMENT" }, select: { linkedId: true } })
    if (links.length === 0) return result

    const linked = await prisma.docComment.findMany({
      where: { id: { in: links.map(link => link.linkedId) } },
      select: { id: true, parentId: true },
    })
    const rootIds = [...new Set(linked.map(comment => comment.parentId ?? comment.id))]

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
  } catch (error) {
    console.error("[comment-task-sync] could not sync thread", { taskId, from, to }, error)
  }
  return result
}
