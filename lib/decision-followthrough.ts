/**
 * Direction B — "decisions produce work" (opportunity 80cb853b).
 *
 * A decided decision is judgment captured perfectly and going nowhere unless
 * something turns it into work. These helpers back the decided-decision
 * surface: draft a Task from the decision, suggest who should own it, and
 * create + link it in one step.
 *
 * The suggestion deliberately prefers `requestedByAgentId` over
 * `requestedById`. The latter is always the API key's owning user even for
 * agent-raised requests, so suggesting from it would name the person who just
 * answered the decision rather than the agent that was blocked waiting on it —
 * the failure documented in feedback f546cf13 and measured in
 * Products/Compass/Designs/decision-directions-2026-09-12.md.
 */
import getPrisma from "@/lib/db"
import { workspaceUpdatesAvailable, recordWorkspaceUpdate } from "@/lib/workspace-updates-capture"
import { workspaceMutationActor } from "@/lib/workspace-update-mutations"
import { eligibleTaskAssignees, type TaskAssignee } from "@/lib/task-assignment"

/** Matches Task.title's column width. */
const TITLE_LIMIT = 255

function truncateOnWord(value: string, limit: number): string {
  if (value.length <= limit) return value
  const clipped = value.slice(0, limit - 1)
  const lastSpace = clipped.lastIndexOf(" ")
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`
}

/**
 * The decision's question becomes the task title; the outcome and rationale
 * become the description, so the work carries its own justification rather
 * than pointing at a record the assignee has to go and read.
 */
export function buildFollowUpDraft(input: { question: string; outcomeLabel: string; rationale: string | null }): { title: string; description: string } {
  const title = truncateOnWord(input.question.trim(), TITLE_LIMIT)
  const lines = [`Follow-up from a decided decision — outcome: **${input.outcomeLabel}**.`]
  const rationale = input.rationale?.trim()
  if (rationale) lines.push("", "**Rationale**", "", rationale)
  return { title, description: lines.join("\n") }
}

/**
 * Suggests the raiser of the decision, agent first. Returns null rather than a
 * wrong guess when the raiser is unknown or is no longer assignable here — a
 * blank picker is honest, a confidently wrong default is not.
 */
export async function suggestFollowUpAssignee(
  workspaceId: string,
  request: { requestedByAgentId: string | null; requestedById: string | null },
): Promise<{ assignee: NonNullable<TaskAssignee>; provenance: string } | null> {
  if (!request.requestedByAgentId && !request.requestedById) return null
  const eligible = await eligibleTaskAssignees(workspaceId)
  const candidates: Array<NonNullable<TaskAssignee>> = [
    ...(request.requestedByAgentId ? [{ type: "AGENT" as const, id: request.requestedByAgentId }] : []),
    ...(request.requestedById ? [{ type: "USER" as const, id: request.requestedById }] : []),
  ]
  for (const candidate of candidates) {
    const match = eligible.find((option) => option.type === candidate.type && option.id === candidate.id && option.available)
    if (match) return { assignee: candidate, provenance: `Suggested because ${match.displayName} raised this decision.` }
  }
  return null
}

/**
 * Creates the follow-up Task and its DECISION link atomically. Either the work
 * exists and cites the decision that caused it, or neither row is written —
 * a task with no lineage is the state this whole feature exists to prevent.
 */
export async function createDecisionFollowUpTask(input: {
  workspaceId: string
  requestId: string
  title: string
  description: string
  assignee: TaskAssignee
}): Promise<{ taskId: string; linkId: string }> {
  const title = input.title.trim()
  if (!title) throw new Error("A follow-up title is required.")
  if (title.length > TITLE_LIMIT) throw new Error(`A follow-up title must be ${TITLE_LIMIT} characters or fewer.`)

  const prisma = getPrisma()
  const request = await prisma.reviewRequest.findFirst({
    where: { id: input.requestId, workspaceId: input.workspaceId, gateType: "TRACKED_DECISION" },
    select: { id: true, state: true },
  })
  if (!request) throw new Error("The decision was not found in this workspace.")
  if (request.state !== "DECIDED") throw new Error("Only a decided decision can produce follow-up work.")

  let assignment: { assigneeUserId: string | null; assigneeAgentId: string | null } = { assigneeUserId: null, assigneeAgentId: null }
  if (input.assignee) {
    const eligible = await eligibleTaskAssignees(input.workspaceId)
    const match = eligible.find((option) => option.type === input.assignee!.type && option.id === input.assignee!.id && option.available)
    if (!match) throw new Error("That assignee is not available in this workspace.")
    assignment = input.assignee.type === "AGENT"
      ? { assigneeUserId: null, assigneeAgentId: input.assignee.id }
      : { assigneeUserId: input.assignee.id, assigneeAgentId: null }
  }

  // Same end-of-column placement convention as addTask in tasks/actions.ts.
  const last = await prisma.task.findFirst({ where: { workspaceId: input.workspaceId, status: "TODO" }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } })
  const sortOrder = last ? last.sortOrder + 1 : 0
  const capture = await workspaceUpdatesAvailable(prisma)
  const actor = capture ? await workspaceMutationActor("UI") : null

  return prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        workspaceId: input.workspaceId,
        title,
        description: input.description || null,
        status: "TODO",
        priority: "MEDIUM",
        sortOrder,
        ...assignment,
      },
    })
    const link = await tx.taskLink.create({
      data: { taskId: task.id, linkedType: "DECISION", linkedId: input.requestId, source: "UI" },
    })
    if (capture && actor) await recordWorkspaceUpdate(tx, { workspaceId: input.workspaceId, entityType: "TASK", entityId: task.id, kind: "CREATED", ...actor })
    return { taskId: task.id, linkId: link.id }
  })
}
