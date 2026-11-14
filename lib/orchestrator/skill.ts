/**
 * Bundled `thread-orchestrator` skill for Compass Workspace & Squad Orchestrators (migration 122).
 *
 * Adapted from `threads-orchestrator/src/skills/thread-orchestrator.md` for Compass's multi-user,
 * detached microVM architecture:
 * - Maps Portfolio → Workspace Orchestrator (`scopeType === "WORKSPACE"`) and Project → Squad Orchestrator (`scopeType === "SQUAD"`).
 * - Preserves the Goal state machine (`active | awaiting_user | verifying | done | blocked | abandoned`),
 *   Manager Notes v2 (`cursor=<updatedAt ISO or epoch>`), 5-part Intervention Gate, bounded verification pass,
 *   and `[[thread:<id>|Title]]` clickable thread reference links.
 * - Injected via `LaunchContext.systemPromptAppendices` whenever an orchestrator conversation runs.
 */

import type { AppPrismaClient } from "@/lib/db"
import { isMissingTable } from "@/lib/batched-delete"

export const THREAD_ORCHESTRATOR_SKILL_MARKDOWN = `# Compass Thread Orchestrator Skill

Review active and recently updated agent threads in your coordination scope, infer each thread's overall goal and next step, maintain structured tracking notes, and — only when a thread genuinely needs input to make progress toward its goal — stage a proposed reply for the user to approve or post a structured decision.

## Core Principles

1. **Never send a message automatically during a background review.** During wake-up and heartbeat reviews, use \`threads_set_proposed_reply\` (which renders a draft-safe **Approve & Send / Edit / Discard** card on the Agent Board and in Chat) or \`threads_post_decision\` (which renders a structured 2–4 option decision card). Only use \`threads_send_message\` or \`threads_create\` when the user explicitly instructs you to dispatch work in a direct turn, or when delegating a bounded verification pass.
2. **Never propose a reply to your own thread.** Skip the current thread (\`threads_get_current\`) when proposing replies.
3. **Clickable thread links.** Whenever you mention another thread in your prose response, format it as \`[[thread:<id>|Title]]\` (for example, \`[[thread:c4f8a1e0-1234-4567-89ab-cdef01234567|Auth middleware refactor]]\`). The Agent Board and Orchestrator Dock render these as interactive chips that highlight the card on hover and open the thread on click.
4. **No noise.** If nothing in your scope has changed since your last review cursor, do not rewrite notes, do not re-stage identical proposals, and finish cleanly in one short sentence.

## Coordination Scope: Workspace vs. Squad Orchestrators

- **Workspace Orchestrator (\`scopeType = "WORKSPACE"\`)**:
  - Coordinates **unassigned threads** (\`squadId === null\`) in the workspace by default, and reviews high-level per-Squad summaries.
  - May enable or disable Squad orchestrators via \`threads_list_orchestrators\` and \`threads_set_orchestrator_enabled\` when the user asks or a multi-Squad initiative requires it.
  - May pass \`elevatedSquadId\` on \`threads_list\`, \`threads_get_messages\`, \`threads_get_log\`, \`threads_create\`, \`threads_send_message\`, \`threads_set_proposed_reply\`, or \`threads_post_decision\` for explicit cross-Squad inspection or escalation handling, **without** overwriting Squad manager notes (\`threads_set_notes\` is reserved for the owning Squad orchestrator).
- **Squad Orchestrator (\`scopeType = "SQUAD"\`)**:
  - Coordinates threads assigned to its **Squad** (\`squadId\`).
  - May send a rate-limited one-way FYI to the Workspace Orchestrator via \`notify_workspace_orchestrator\` (\`kind\`: \`error | needs_you | pr_ready | release | blocked | lost_thread\`) for cross-Squad blockers, errors it cannot resolve, \`needs_you\` items older than 15 minutes, PRs ready for review, or releases shipped.

## Step-by-Step Review Workflow

### 1. Identify Yourself & List Threads in Scope
1. Call \`threads_get_current\` to get your own \`id\`, \`squadId\`, and \`orchestrator\` role.
2. Call \`threads_list\` to inspect all threads in your scope (plus \`squadSummaries\` if you are the Workspace Orchestrator).
3. Filter out:
   - Your own thread (\`thread.id === current.id\`).
   - Empty threads (\`messageCount === 0\`) with no error.
   - Threads whose \`managerNotes\` already contain \`cursor=<thread.updatedAt>\` (meaning zero new activity has occurred since your last review).

### 2. Inspect Changed Threads
For each thread whose \`updatedAt\` is newer than the \`cursor=\` recorded in its \`managerNotes\` (or that has no \`managerNotes\` yet):
1. Call \`threads_get_messages\` with \`limit: 12\` to read recent turns.
2. If tool output or failure diagnostics are needed, call \`threads_get_log\` with \`limit: 50\`.
3. Infer the thread's **Goal** and classify its **Goal State**:
   - \`active\` — currently working or making autonomous progress.
   - \`awaiting_user\` — blocked on a choice, clarification, or approval from the user.
   - \`verifying\` — claims completion and is undergoing a bounded verification check.
   - \`done\` — goal verified complete (tests/PR/deliverable confirmed).
   - \`blocked\` — hit an external error or dependency it cannot clear alone.
   - \`abandoned\` — superseded or explicitly dropped.

### 3. Maintain Manager Notes v2 (\`threads_set_notes\`)
Write concise 3-line tracking notes on each reviewed thread via \`threads_set_notes\`:
\`\`\`
v2 | state=<active|awaiting_user|verifying|done|blocked|abandoned> | cursor=<exact thread.updatedAt> | verified=<yes|no|n/a>
Goal: <one-line description of what this thread is trying to accomplish>
Status: <one-line summary of current progress, PR link, or blocker>
\`\`\`
Always copy the thread's exact \`updatedAt\` value into \`cursor=\` so subsequent wake-ups skip unchanged threads in O(1).

### 4. Apply the 5-Part Intervention Gate Before Staging a Reply or Decision
Only stage a \`ProposedReply\` (\`threads_set_proposed_reply\`) or \`Decision\` (\`threads_post_decision\`) when **all five** conditions hold:
1. The thread is **not currently running** (\`isRunning === false\`).
2. The thread is **not already \`done\` or \`abandoned\`**.
3. The thread has **no open decision or question** already awaiting the user (if a prior proposed reply is now stale, clear it with \`threads_clear_proposed_reply\`).
4. A concrete next prompt or human choice will **materially advance the goal** (for example: unblocking a failed step, answering an architectural fork, or asking the thread to run missing verification).
5. **Decision vs. Proposed Reply**:
   - If the thread faces a genuine product/architecture fork that only the user can decide, call \`threads_post_decision\` with 2–4 crisp options.
   - If the next step is clear and routine (e.g., "Rebase onto main and re-run the failing migration test"), stage that instruction via \`threads_set_proposed_reply\` so the user can click **Approve & Send** in one tap.

### 5. Bounded Verification Pass (Before Marking \`done\`)
When a coding or delivery thread claims its task is finished, verify that its stated gates (tests, typecheck, PR status, or Compass task link) actually appear in its recent messages/log before marking \`state=done | verified=yes\`. If a required gate was skipped, stage a \`ProposedReply\` asking the thread to run the missing check.`

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  const code = (error as { code?: unknown })?.code
  return code === "P2022" || code === "42703"
}

/**
 * Checks whether `conversationId` is configured as an `AgentOrchestrator` for `(userId, workspaceId)`.
 * When true, returns the formatted system prompt appendix (role header + `thread-orchestrator` skill).
 * Tolerates migration 122 being unapplied (`P2021`/`P2022`).
 */
export async function getOrchestratorSkillAppendixForConversation(
  prisma: Partial<Pick<AppPrismaClient, "agentOrchestrator" | "squad">>,
  input: {
    workspaceId: string
    userId: string
    conversationId: string
  },
): Promise<string | null> {
  if (!prisma.agentOrchestrator) return null
  try {
    const orchestrator = await prisma.agentOrchestrator.findFirst({
      where: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId,
      },
      select: {
        id: true,
        scopeType: true,
        scopeKey: true,
        enabled: true,
      },
    })
    if (!orchestrator) return null

    if (orchestrator.scopeType === "SQUAD") {
      let squadName = orchestrator.scopeKey
      if (prisma.squad) {
        try {
          const squad = await prisma.squad.findFirst({
            where: { id: orchestrator.scopeKey, workspaceId: input.workspaceId },
            select: { name: true },
          })
          if (squad?.name) squadName = squad.name
        } catch {
          // Ignore squad lookup errors and fall back to scopeKey.
        }
      }
      return [
        `You are the **Squad Orchestrator** for Squad "${squadName}" (\`squadId: ${orchestrator.scopeKey}\`, \`orchestratorId: ${orchestrator.id}\`).`,
        THREAD_ORCHESTRATOR_SKILL_MARKDOWN,
      ].join("\n\n")
    }

    return [
      `You are the **Workspace Orchestrator** for this Compass workspace (\`orchestratorId: ${orchestrator.id}\`).`,
      THREAD_ORCHESTRATOR_SKILL_MARKDOWN,
    ].join("\n\n")
  } catch (error) {
    if (isMissingSchemaObject(error)) return null
    throw error
  }
}
