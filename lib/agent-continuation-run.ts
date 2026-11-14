/**
 * Server-initiated continuation run launcher for an existing `AgentConversation`.
 *
 * Shared by:
 *   - Deadline-parked `AskUserQuestion` answers (`lib/agent-inbox-questions.ts`), where the original
 *     sandbox reached its wall-clock deadline (`deadlineAt - 30s`) and saved its SDK session + disk.
 *   - `ScheduleWakeup` timer firings (`lib/agent-scheduled-wakeups.ts`), where the agent finished a turn
 *     cleanly and scheduled a future self-wakeup.
 *
 * Preserves full conversation continuity: appends the user/wakeup turn to `AgentMessage`, plans SDK
 * session transcript resumption (`planAgentSession`), reuses or resumes the conversation's persistent
 * sandbox (`acquireConversationSandbox`), and materializes workspace docs (`_doc.md`).
 */

import { after } from "next/server"
import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { authorColumn, loadConversationAttribution, type ConversationAttribution } from "@/lib/agent-attribution"
import { labelUserTurn } from "@/lib/agent-author-label"
import { checkAgentRunCaps, checkAgentUsageLimit } from "@/lib/agent-limits"
import { resolveWorkspaceAgentModel } from "@/lib/workspace-anthropic-key"
import { resolveGatewayCredential, resolveAgentHarness } from "@/lib/agent-harness"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { resolveRunSnapshot } from "@/lib/agent-sandbox-class"
import { AgentSelectionError, resolveRunAgent } from "@/lib/agent-run-identity"
import { BUILT_IN_AGENT_SELECTION } from "@/lib/agent-defaults"
import type { AgentRecord } from "@/lib/agent-ownership"
import { effectiveTurnModel } from "@/lib/agent-turn-model"
import {
  AgentRunError,
  DEFAULT_AGENT_RUN_BUDGET_MS,
  agentRunAttributionAvailable,
  agentRunsAvailable,
  createAgentRun,
  findActiveAgentRun,
} from "@/lib/agent-runs"
import { buildResumePrompt, planAgentSession } from "@/lib/agent-session"
import { launchQueuedAgentRun, type LaunchContext } from "@/lib/agent-run-launch"
import { workspaceFraming } from "@/lib/agent-run-sandbox"
import { trustedCompassBaseUrl } from "@/lib/compass-url"
import { readWorkspaceAgentRepos } from "@/lib/agent-github-repos"
import { mintAgentGithubEnv } from "@/lib/github-app-token"
import { developerNpmToken } from "@/lib/agent-github-access"

const MAX_HISTORY_MESSAGES = 20

export type ContinuationRunOutcome =
  | { status: "started"; runId: string; conversationId: string }
  | { status: "already_running"; runId?: string; conversationId: string }
  | { status: "refused"; code: string; message: string }

export type ContinuationDeps = {
  prisma: AppPrismaClient
  getSnapshotId: () => Promise<string | null>
  defer: (task: () => Promise<unknown>) => Promise<void> | void
  launch: (context: LaunchContext) => Promise<{ started: boolean }>
  now: () => Date
  origin: () => string
  env: Record<string, string | undefined>
}

async function defaultDefer(task: () => Promise<unknown>) {
  try {
    after(task)
    return
  } catch {
    // Outside a Next.js request context (cron test, CLI, unit test): execute inline.
  }
  await task()
}

function defaultDeps(): ContinuationDeps {
  return {
    prisma: getPrisma(),
    getSnapshotId: getGoldenSnapshotId,
    defer: defaultDefer,
    launch: launchQueuedAgentRun,
    now: () => new Date(),
    origin: () => trustedCompassBaseUrl().origin,
    env: process.env,
  }
}

function assembleContinuationPrompt(
  ws: { id: string; name: string; orgSlug: string; workspaceSlug: string },
  history: { role: string; content: string; authorUserId?: string | null }[],
  userMessage: string,
  attribution: ConversationAttribution,
  currentUserId: string,
): string {
  const framing = workspaceFraming(ws)
  const shared = attribution.shared ? attribution : null
  const userTurn = (text: string, authorUserId: string | null | undefined) =>
    shared ? labelUserTurn(shared.labelFor(authorUserId), text) : `User: ${text}`
  const transcript = history
    .map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : userTurn(m.content, m.authorUserId)))
    .join("\n")
  return [framing, transcript, userTurn(userMessage, currentUserId), "Assistant:"].filter(Boolean).join("\n\n")
}

export async function startConversationContinuationRun(
  input: {
    conversationId: string
    workspaceId: string
    userId: string
    message: string
    /** Explicit agent id from the originating run/wakeup, or omitted to inherit from the latest run. */
    preferredAgentId?: string | null
    /** When true, returns immediately once the QUEUED run row is created and boots the sandbox in `defer`. */
    deferLaunch?: boolean
    /** Skip inserting a new `AgentMessage` when the caller already wrote one inside its own transaction. */
    existingUserMessageId?: string
  },
  overrides: Partial<ContinuationDeps> = {},
): Promise<ContinuationRunOutcome> {
  const deps = { ...defaultDeps(), ...overrides }
  const { prisma } = deps
  const now = deps.now()
  const turnMessage = input.message.trim()
  if (!turnMessage) {
    return { status: "refused", code: "EMPTY_MESSAGE", message: "Continuation message cannot be empty." }
  }

  const workspace = await prisma.workspace.findFirst({
    where: { id: input.workspaceId, members: { some: { userId: input.userId } } },
    select: { id: true, name: true, slug: true, organization: { select: { slug: true } } },
  })
  if (!workspace) {
    return { status: "refused", code: "WORKSPACE_ACCESS_DENIED", message: "Workspace not found or user is no longer a member." }
  }

  if (!(await agentRunsAvailable(prisma))) {
    return { status: "refused", code: "AGENT_RUN_UNAVAILABLE", message: "Background agent runs are not available yet." }
  }

  const active = await findActiveAgentRun({ prisma, conversationId: input.conversationId })
  if (active) {
    return { status: "already_running", runId: active.id, conversationId: input.conversationId }
  }

  const limit = await checkAgentUsageLimit(input.userId)
  if (!limit.allowed) {
    return { status: "refused", code: "USER_LIMIT_REACHED", message: limit.reason }
  }

  // Inherit the conversation's most recent run agent when not explicitly specified.
  let targetAgentId = input.preferredAgentId
  if (targetAgentId === undefined) {
    try {
      const latestRun = await prisma.agentRun.findFirst({
        where: { conversationId: input.conversationId },
        orderBy: { createdAt: "desc" },
        select: { agentId: true },
      })
      targetAgentId = latestRun?.agentId ?? null
    } catch {
      targetAgentId = null
    }
  }

  let runAgent: AgentRecord | null = null
  if (targetAgentId) {
    try {
      runAgent = await resolveRunAgent(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        requestedAgentId: targetAgentId,
      })
    } catch (error) {
      if (!(error instanceof AgentSelectionError)) throw error
      runAgent = null
    }
  } else {
    try {
      runAgent = await resolveRunAgent(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        requestedAgentId: BUILT_IN_AGENT_SELECTION,
      })
    } catch {
      runAgent = null
    }
  }

  if (runAgent && !(await agentRunAttributionAvailable(prisma))) {
    runAgent = null
  }
  if (runAgent) {
    const capped = await checkAgentRunCaps(prisma, runAgent.id)
    if (!capped.allowed) {
      return { status: "refused", code: "AGENT_CAP_REACHED", message: "Agent concurrency or daily run limit reached." }
    }
  }

  let sandboxClass: "STANDARD" | "DEVELOPER" = "STANDARD"
  let snapshotId = await deps.getSnapshotId()
  if (!snapshotId) {
    return {
      status: "refused",
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "Agent runtime is not initialized (no golden snapshot).",
    }
  }
  if (runAgent) {
    const picked = await resolveRunSnapshot(prisma, { workspaceId: input.workspaceId, agentId: runAgent.id })
    if (!picked.ok) {
      return { status: "refused", code: picked.code, message: picked.message }
    }
    snapshotId = picked.snapshotId
    sandboxClass = picked.sandboxClass
  }

  const harness = resolveAgentHarness(deps.env.AGENT_HARNESS)
  const resolved = harness === "claude" ? await resolveWorkspaceAgentModel(prisma, input.workspaceId) : null
  if (resolved && !resolved.ok) {
    return { status: "refused", code: "MODEL_UNAVAILABLE", message: resolved.message }
  }
  const gatewayApiKey = harness === "opencode" ? await resolveGatewayCredential(deps.env) : undefined
  if (harness === "opencode" && !gatewayApiKey) {
    return { status: "refused", code: "GATEWAY_UNAVAILABLE", message: "No AI Gateway credential available." }
  }

  const attribution = await loadConversationAttribution(prisma, {
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
  })
  let savedMessageId = input.existingUserMessageId
  if (!savedMessageId) {
    const authorData = await authorColumn(prisma, input.userId)
    const saved = await prisma.agentMessage.create({
      data: {
        conversationId: input.conversationId,
        role: "user",
        content: turnMessage,
        ...authorData,
      },
      select: { id: true },
    })
    savedMessageId = saved.id
    await prisma.agentConversation
      .update({ where: { id: input.conversationId }, data: { updatedAt: now }, select: { id: true } })
      .catch(() => {})
  }

  const historyRows = await prisma.agentMessage.findMany({
    where: { conversationId: input.conversationId, ...(savedMessageId ? { id: { not: savedMessageId } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_HISTORY_MESSAGES,
    select: attribution.shared ? { role: true, content: true, authorUserId: true } : { role: true, content: true },
  })

  const prompt = assembleContinuationPrompt(
    {
      id: workspace.id,
      name: workspace.name,
      orgSlug: workspace.organization.slug,
      workspaceSlug: workspace.slug,
    },
    historyRows.reverse(),
    turnMessage,
    attribution,
    input.userId,
  )

  const sessionPlan = await planAgentSession({
    prisma,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    currentMessageId: savedMessageId,
    attribution,
    harness,
  })
  const extraFiles: { path: string; content: Buffer }[] = []
  let turnPrompt = prompt
  let sessionEnv: { sessionId: string; mode: "new" | "resume" } | undefined
  if (sessionPlan.enabled) {
    if (sessionPlan.resume) {
      turnPrompt = buildResumePrompt(
        sessionPlan.resume.gap,
        turnMessage,
        attribution.shared ? attribution.labelFor(input.userId) : undefined,
      )
      extraFiles.push(
        { path: "session-in.jsonl.gz", content: Buffer.from(sessionPlan.resume.bytes) },
        { path: "fallback-prompt.txt", content: Buffer.from(prompt, "utf8") },
      )
      sessionEnv = { sessionId: sessionPlan.sessionId, mode: "resume" }
    } else {
      sessionEnv = { sessionId: sessionPlan.sessionId, mode: "new" }
    }
  }

  const turnModel = effectiveTurnModel({ explicit: null, agentModel: runAgent?.model, harness })
  const budgetMs = DEFAULT_AGENT_RUN_BUDGET_MS

  let created: Awaited<ReturnType<typeof createAgentRun>>
  try {
    created = await createAgentRun({
      prisma,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentId: runAgent?.id ?? null,
      invokedByUserId: input.userId,
      model: turnModel,
      budgetMs,
      now,
      fenceConversation: true,
    })
  } catch (error) {
    if (error instanceof AgentRunError && error.code === "RUN_IN_FLIGHT") {
      return { status: "already_running", conversationId: input.conversationId }
    }
    throw error
  }

  const githubEnv = await mintAgentGithubEnv(await readWorkspaceAgentRepos(prisma, input.workspaceId)).catch(() => null)
  const developer = { enabled: sandboxClass === "DEVELOPER", npmToken: developerNpmToken() }

  const launchCtx: LaunchContext = {
    prisma,
    run: created.run,
    workerToken: created.workerToken,
    sandboxName: created.sandboxName,
    userId: input.userId,
    workspace: { id: input.workspaceId },
    agent: runAgent,
    prompt: turnPrompt,
    snapshotId,
    harness,
    model: resolved?.ok ? resolved : undefined,
    gatewayApiKey,
    budgetMs,
    mcpBaseUrl: deps.origin(),
    bypassSecret: deps.env.MCP_BYPASS_SECRET,
    session: sessionEnv,
    extraFiles,
    shared: attribution.shared,
    docs: true,
    githubEnv,
    developer,
    reuseConversationSandbox: { conversationId: input.conversationId, developer: developer.enabled },
  }

  if (input.deferLaunch) {
    await deps.defer(() => deps.launch(launchCtx))
    return { status: "started", runId: created.run.id, conversationId: input.conversationId }
  }

  const launched = await deps.launch(launchCtx)
  if (!launched.started) {
    return { status: "refused", code: "AGENT_RUN_START_FAILED", message: "The continuation agent run could not start." }
  }
  return { status: "started", runId: created.run.id, conversationId: input.conversationId }
}
