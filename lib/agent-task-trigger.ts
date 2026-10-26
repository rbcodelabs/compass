/**
 * Assigning a task to a cloud agent starts a run (ADR "Cloud agents as first-class identities", phase 4).
 *
 * WHEN A RUN STARTS. Only where a person does it, from the signed-in app, so the run can be attributed to that person
 * (`invoked_by_user_id`) and checked against what they may run:
 *
 *   - the task UI (create, edit, linked tasks) and the detail panel's assignee field,
 *   - a Doc comment that @mentions an agent and creates a task (lib/doc-comment-tasks.ts).
 *
 * Deliberately NOT triggered: MCP and REST task writes (the actor may itself be an agent or a service key, so a chain of
 * agents assigning each other could start runs nobody asked for, and a personal API key carries no "this person is
 * watching" signal), decision follow-through and every other automated system flow. Those still record the assignment; the
 * agent simply has the task in its queue, as before.
 *
 * WHAT HAPPENS. In this order, and any "no" leaves the assignment itself untouched (the assignment is already saved; this
 * only decides whether a run also starts, and tells the person why not):
 *
 *   1. the assignee is an ACTIVE CLOUD agent and agents are enabled (an EXTERNAL agent keeps today's behaviour: queue only);
 *   2. the assignee actually changed (re-saving the same assignee starts nothing);
 *   3. `resolveRunAgent` proves the person may run this agent here: cloud, active, live grant in this workspace and
 *      `canInvokeAgent` (a personal agent: its owner only; a shared agent: its invoke policy);
 *   4. background runs and attribution are available, the person is under their own daily limit, and the agent is under its
 *      concurrent and daily caps (lib/agent-limits.ts);
 *   5. one conversation per (person, task), found by its task reference or created, with at most ONE non-terminal run
 *      (createAgentRun's fence); a second trigger while one is running reports `already_running` and starts nothing.
 *
 * The run is attributed (agentId, invokedByUserId), acts only through the agent's own grants (an agent-scoped key tied to
 * this run), and its sandbox is started after the person has their answer (`defer`), so saving the assignment is never
 * slowed by a sandbox boot. The function never throws: a failure becomes `refused`.
 */
import { after } from "next/server"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { authorColumn } from "@/lib/agent-attribution"
import { checkAgentRunCaps, checkAgentUsageLimit } from "@/lib/agent-limits"
import { resolveWorkspaceAgentModel } from "@/lib/workspace-anthropic-key"
import { agentKind, findAgentById } from "@/lib/agent-ownership"
import { resolveGatewayCredential, resolveAgentHarness } from "@/lib/agent-harness"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { AgentSelectionError, resolveRunAgent } from "@/lib/agent-run-identity"
import { AgentRunError, DEFAULT_AGENT_RUN_BUDGET_MS, agentRunAttributionAvailable, agentRunsAvailable, createAgentRun, finalizeAgentRun, findActiveAgentRun } from "@/lib/agent-runs"
import { launchQueuedAgentRun, type LaunchContext } from "@/lib/agent-run-launch"
import { workspaceFraming } from "@/lib/agent-run-sandbox"
import { HANDOFF_POLICIES } from "@/lib/agent-handoff-kinds"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { displayIdFromRow } from "@/lib/work-item-ids"
import { createHash } from "node:crypto"
import { isDsqlWriteConflict } from "@/lib/dsql-conflict"

export type AgentRunOutcome =
  /** Nothing to report: not an agent assignment, nothing changed, agents off, or an EXTERNAL agent (queue only). */
  | { status: "skipped" }
  | { status: "started"; agentName: string; runId: string; conversationId: string; conversationUrl: string }
  /** A run for this task is already in progress; nothing new was started. */
  | { status: "already_running"; agentName: string; conversationId: string; conversationUrl: string }
  /** The assignment is saved but no run started. `message` says why, in a sentence a person can act on. */
  | { status: "refused"; code: AgentRunRefusalCode; message: string; agentName?: string }

export type AgentRunRefusalCode =
  | "AGENT_NOT_AVAILABLE"
  | "AGENT_NOT_INVOKABLE"
  | "AGENT_RUN_UNAVAILABLE"
  | "USER_LIMIT_REACHED"
  | "AGENT_CAP_REACHED"
  | "AGENT_RUNTIME_UNAVAILABLE"
  | "AGENT_RUN_FAILED"
  /** A concurrent change got in the way and no run exists yet: assigning again will work. */
  | "AGENT_RUN_RETRY"

export type TriggerInput = {
  taskId: string
  /** The signed-in person who made the assignment. */
  actingUserId: string
  /** The task's assignee agent BEFORE this change (null/undefined = none, or a task that did not exist yet). */
  previousAssigneeAgentId?: string | null
  /** Set when the task was created from a Doc comment. */
  comment?: { id: string; docId: string; body?: string | null }
}

export type TriggerDeps = {
  prisma: AppPrismaClient
  getSnapshotId: () => Promise<string | null>
  /** Runs `task` after the caller has its answer; falls back to running it inline outside a request scope. */
  defer: (task: () => Promise<unknown>) => Promise<void> | void
  launch: (context: LaunchContext) => Promise<unknown>
  finalize: typeof finalizeAgentRun
  now: () => Date
  origin: () => string
  env: Record<string, string | undefined>
}

const EXCERPT_MAX = 600

/**
 * A triggered run is created QUEUED and its sandbox is started after the response (`defer`). If that function instance dies
 * between the two, the run is left QUEUED with nothing behind it, and until the (once a day) sweeper collects it that run would
 * hold one of the agent's concurrent slots and block this conversation with "already running". The grace is longer than the 300 s
 * function budget the start runs under (app/[orgSlug]/[workspaceSlug]/layout.tsx), so a start that is merely slow is never closed
 * from under itself; a run still unstarted after this long is dead and is closed here, on the next trigger, instead of waiting
 * for the sweeper. (The launcher also tears down its sandbox if it finds its run already closed.)
 */
export const UNSTARTED_RUN_GRACE_MS = 6 * 60_000

function clip(text: string | null | undefined, max = EXCERPT_MAX): string {
  const clean = (text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The capped, untrusted excerpt of the task (and comment) the prompt shows; the agent reads the full text with its tools. */
export function buildTaskContext(task: { title: string; description?: string | null }, comment?: { body?: string | null } | null): string {
  return [
    `Task title: ${clip(task.title, 200)}`,
    task.description ? `Task description: ${clip(task.description)}` : "",
    comment?.body ? `Comment: ${clip(comment.body)}` : "",
  ].filter(Boolean).join("\n")
}

async function defaultDefer(task: () => Promise<unknown>) {
  try {
    after(task)
    return
  } catch {
    // Not inside a request (a script, a job, a test): there is no response to be late for, so just run it.
  }
  await task()
}

function defaultDeps(): TriggerDeps {
  return {
    prisma: getPrisma(),
    getSnapshotId: getGoldenSnapshotId,
    defer: defaultDefer,
    launch: launchQueuedAgentRun,
    finalize: finalizeAgentRun,
    now: () => new Date(),
    origin: () => trustedCompassBaseUrl().origin,
    env: process.env,
  }
}

/**
 * The conversation for (person, task), as a deterministic UUID. Its primary key is the dedup: two concurrent first
 * assignments both compute the same id, exactly one insert wins, and the other reads the winner's row. (A lookup by title
 * could not do this: it raced, and it would also have adopted a chat the person had merely named like the task. Advisory
 * locks are not an option on Aurora DSQL.) The hash input includes the person, so nobody can land on another person's row.
 */
export function taskConversationId(userId: string, taskId: string): string {
  const bytes = createHash("sha256").update(JSON.stringify(["compass:task-run-conversation", userId, taskId])).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4 layout
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const refused = (code: AgentRunRefusalCode, message: string, agentName?: string): AgentRunOutcome => ({ status: "refused", code, message, ...(agentName ? { agentName } : {}) })

/**
 * Closes triggered runs that were queued but never started (see {@link UNSTARTED_RUN_GRACE_MS}): this agent's (they hold its
 * concurrent slots), and any in this conversation whatever agent they were for (they would block it with "already running").
 */
async function reapUnstartedRuns(deps: TriggerDeps, agentId: string, conversationId: string) {
  const cutoff = new Date(deps.now().getTime() - UNSTARTED_RUN_GRACE_MS)
  const stale = await deps.prisma.agentRun.findMany({
    where: { kind: "TASK_ASSIGNMENT", status: "QUEUED", startedAt: null, statusChangedAt: { lte: cutoff }, OR: [{ agentId }, { conversationId }] },
    select: { id: true },
    take: 25,
  })
  for (const { id } of stale) {
    await deps.finalize({ prisma: deps.prisma, runId: id, status: "FAILED", error: "The agent run could not start.", errorCode: "RUN_START_FAILED", now: deps.now() }).catch((error: unknown) => {
      console.error("[agent-task-trigger] could not close an unstarted run", { runId: id, error })
    })
  }
}

export async function startRunForAssignedTask(input: TriggerInput, overrides: Partial<TriggerDeps> = {}): Promise<AgentRunOutcome> {
  try {
    return await run(input, { ...defaultDeps(), ...overrides })
  } catch (error) {
    // The assignment is already saved; a run that cannot start must never turn that into an error for the person.
    console.error("[agent-task-trigger] could not start a run", { taskId: input.taskId, error })
    return refused("AGENT_RUN_FAILED", "The task was assigned, but the run could not be started. Try assigning it again in a moment.")
  }
}

async function run(input: TriggerInput, deps: TriggerDeps): Promise<AgentRunOutcome> {
  const { prisma } = deps
  const task = await prisma.task.findFirst({
    where: { id: input.taskId },
    select: {
      id: true, workspaceId: true, title: true, description: true, seqPrefix: true, seqNumber: true, assigneeAgentId: true,
      workspace: { select: { id: true, name: true, slug: true, organization: { select: { slug: true } } } },
    },
  })
  const agentId = task?.assigneeAgentId
  if (!task || !agentId) return { status: "skipped" }
  // Re-saving the same assignee (or any save that leaves it as it was) starts nothing.
  if (agentId === (input.previousAssigneeAgentId ?? null)) return { status: "skipped" }

  const agent = await findAgentById(prisma, agentId)
  // An EXTERNAL agent has no sandbox to run in: assignment stays a queue entry for whatever drives it.
  if (!agent || agentKind(agent) !== "CLOUD") return { status: "skipped" }

  let runAgent
  try {
    runAgent = await resolveRunAgent(prisma, { userId: input.actingUserId, workspaceId: task.workspaceId, requestedAgentId: agent.id })
  } catch (error) {
    if (error instanceof AgentSelectionError) {
      return error.code === "AGENT_NOT_INVOKABLE"
        ? refused("AGENT_NOT_INVOKABLE", `The task was assigned to ${agent.name}, but you are not allowed to run it, so no run started.`, agent.name)
        : refused("AGENT_NOT_AVAILABLE", `The task was assigned to ${agent.name}, but that agent is not available to run in this workspace right now, so no run started.`, agent.name)
    }
    throw error
  }
  if (!runAgent) return refused("AGENT_NOT_AVAILABLE", `The task was assigned to ${agent.name}, but no run started.`, agent.name)

  if (!(await agentRunsAvailable(prisma)) || !(await agentRunAttributionAvailable(prisma))) {
    return refused("AGENT_RUN_UNAVAILABLE", `The task was assigned to ${runAgent.name}. Background agent runs are not available on this deployment yet, so no run started.`, runAgent.name)
  }

  const conversationId = taskConversationId(input.actingUserId, task.id)
  await reapUnstartedRuns(deps, runAgent.id, conversationId)

  const harness = resolveAgentHarness(deps.env.AGENT_HARNESS)
  // The same provider/credential resolution the turn route uses (AGENT_MODEL_PROVIDER: anthropic or bedrock), plus the workspace's own Anthropic key (BYOK) when it has one. Only the Claude harness has one.
  const resolvedModel = harness === "claude" ? await resolveWorkspaceAgentModel(prisma, task.workspaceId, deps.env) : null
  const gatewayApiKey = harness === "opencode" ? await resolveGatewayCredential(deps.env) : undefined
  const snapshotId = await deps.getSnapshotId()
  if (!snapshotId || (resolvedModel !== null && !resolvedModel.ok) || (harness === "opencode" && !gatewayApiKey)) {
    return refused("AGENT_RUNTIME_UNAVAILABLE", `The task was assigned to ${runAgent.name}. The agent runtime is not set up on this deployment, so no run started.`, runAgent.name)
  }

  const reference = displayIdFromRow("task", task) ?? `Task ${task.id.slice(0, 8)}`
  const basePath = `/${task.workspace.organization.slug}/${task.workspace.slug}`
  const conversationUrl = (id: string) => `${basePath}/agent?c=${id}`

  // One conversation per (person, task), found by its deterministic id (see taskConversationId).
  const titlePrefix = `${reference}: `
  const existing = await prisma.agentConversation.findFirst({ where: { id: conversationId, workspaceId: task.workspaceId, userId: input.actingUserId }, select: { id: true } })
  if (existing && (await findActiveAgentRun({ prisma, conversationId: existing.id }))) {
    return { status: "already_running", agentName: runAgent.name, conversationId: existing.id, conversationUrl: conversationUrl(existing.id) }
  }
  // After the in-flight check on purpose: "already running" is the more useful answer when both apply.
  const usage = await checkAgentUsageLimit(input.actingUserId)
  if (!usage.allowed) return refused("USER_LIMIT_REACHED", `The task was assigned to ${runAgent.name}, but no run started: ${usage.reason}`, runAgent.name)
  const capped = await checkAgentRunCaps(prisma, runAgent.id)
  if (!capped.allowed) return refused("AGENT_CAP_REACHED", `The task was assigned to ${runAgent.name}, but no run started: ${capped.reason}`, runAgent.name)

  let conversation = existing
  if (!conversation) {
    try {
      conversation = await prisma.agentConversation.create({
        data: { id: conversationId, workspaceId: task.workspaceId, userId: input.actingUserId, title: `${titlePrefix}${task.title}`.slice(0, 80), updatedAt: new Date() },
        select: { id: true },
      })
    } catch (error) {
      // A concurrent trigger for the same (person, task) created it first (unique id, or DSQL aborting the loser). Only the
      // row actually being there makes that so; otherwise the conflict is real and the person can simply try again.
      const duplicate = typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
      if (!duplicate && !isDsqlWriteConflict(error)) throw error
      conversation = await prisma.agentConversation.findFirst({ where: { id: conversationId, workspaceId: task.workspaceId, userId: input.actingUserId }, select: { id: true } })
      if (!conversation) return refused("AGENT_RUN_RETRY", `The task was assigned to ${runAgent.name}, but another change was in progress and no run started. Assign it again in a moment.`, runAgent.name)
    }
  }

  const instruction = HANDOFF_POLICIES.TASK_ASSIGNMENT.instruction({
    status: "RUNNING",
    kind: "TASK_ASSIGNMENT",
    taskId: task.id,
    ...(input.comment ? { commentId: input.comment.id, docId: input.comment.docId } : {}),
    taskContext: buildTaskContext(task, input.comment),
  })

  let created: Awaited<ReturnType<typeof createAgentRun>>
  try {
    created = await createAgentRun({
      prisma,
      conversationId: conversation.id,
      workspaceId: task.workspaceId,
      userId: input.actingUserId,
      agentId: runAgent.id,
      invokedByUserId: input.actingUserId,
      kind: "TASK_ASSIGNMENT",
      budgetMs: DEFAULT_AGENT_RUN_BUDGET_MS,
      fenceConversation: true,
    })
  } catch (error) {
    if (error instanceof AgentRunError) {
      if (error.code === "RUN_IN_FLIGHT") return { status: "already_running", agentName: runAgent.name, conversationId: conversation.id, conversationUrl: conversationUrl(conversation.id) }
      return refused("AGENT_RUN_FAILED", `The task was assigned to ${runAgent.name}, but no run started: ${error.message}`, runAgent.name)
    }
    // Aurora DSQL aborts the loser of two concurrent writes to the conversation row. "A concurrent start won" is only true if a
    // live run now exists, so look; if none does, nothing started and the person must be told to retry, not that it is running.
    if (isDsqlWriteConflict(error)) {
      if (await findActiveAgentRun({ prisma, conversationId: conversation.id })) {
        return { status: "already_running", agentName: runAgent.name, conversationId: conversation.id, conversationUrl: conversationUrl(conversation.id) }
      }
      return refused("AGENT_RUN_RETRY", `The task was assigned to ${runAgent.name}, but another change was in progress and no run started. Assign it again in a moment.`, runAgent.name)
    }
    throw error
  }

  // Written after the run exists, so a run refused above leaves no orphaned "asked" message in the conversation.
  await prisma.agentMessage.create({
    data: { conversationId: conversation.id, role: "user", content: instruction, ...(await authorColumn(prisma, input.actingUserId)) },
    select: { id: true },
  })

  const prompt = [
    workspaceFraming({ id: task.workspace.id, name: task.workspace.name, orgSlug: task.workspace.organization.slug, workspaceSlug: task.workspace.slug }),
    `User: ${instruction}`,
    "Assistant:",
  ].join("\n\n")

  await deps.defer(() => deps.launch({
    prisma,
    run: created.run,
    workerToken: created.workerToken,
    sandboxName: created.sandboxName,
    userId: input.actingUserId,
    workspace: { id: task.workspace.id },
    agent: runAgent,
    prompt,
    snapshotId,
    harness,
    model: resolvedModel?.ok ? resolvedModel : undefined,
    gatewayApiKey,
    budgetMs: DEFAULT_AGENT_RUN_BUDGET_MS,
    mcpBaseUrl: deps.origin(),
    bypassSecret: deps.env.MCP_BYPASS_SECRET,
  }))

  return { status: "started", agentName: runAgent.name, runId: created.run.id, conversationId: conversation.id, conversationUrl: conversationUrl(conversation.id) }
}
