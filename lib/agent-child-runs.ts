/**
 * Durable server-side projection and read helpers for harness-native child sub-agents
 * (`Task` / `Agent` SDK calls) inside `AgentRun`s (migration 120).
 *
 * Tolerates `120_agent_child_runs` being unapplied (`P2021` / `P2022`) on every read and write
 * path so code can deploy safely before `/api/admin/migrate` executes.
 */

import { randomUUID } from "node:crypto"
import type { AppPrismaClient } from "@/lib/db"
import { isMissingTable } from "@/lib/batched-delete"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import { humanizeToolName } from "@/lib/agent-tools"
import type { ToolStep } from "@/lib/agent-run-stream"
import {
  agentLabel,
  type ChildAgentStatus,
  type SerializedChildAgentRun,
} from "@/lib/agent/child-agent-tree"

export const MAX_PERSISTED_CHILD_STEPS = 100
const DETAIL_KEYS = ["query", "url", "path", "file_path", "pattern", "id", "name", "title", "slug"]
const SUBAGENT_TOOLS = new Set(["Task", "Agent"])

type ChildRunDbClient = {
  agentChildRun?: Pick<
    AppPrismaClient["agentChildRun"],
    "findMany" | "create" | "update" | "updateMany" | "deleteMany"
  >
}

function isMissingSchemaObject(error: unknown): boolean {
  if (isMissingTable(error)) return true
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2022"
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002"
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function summarizeInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return clip(`${key}: ${value}`, 140)
  }
  return undefined
}

function extractResultText(content: unknown, max: number): string | undefined {
  if (typeof content === "string") {
    const c = clip(content, max)
    return c || undefined
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n")
    const c = clip(joined, max)
    return c || undefined
  }
  return undefined
}

export function parseChildRunSteps(stepsJson: string | null | undefined): ToolStep[] {
  if (!stepsJson) return []
  try {
    const parsed = JSON.parse(stepsJson) as unknown
    if (!Array.isArray(parsed)) return []
    const steps: ToolStep[] = []
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as Record<string, unknown>
      if (typeof item.id !== "string" || typeof item.label !== "string") continue
      const status = item.status === "error" || item.status === "done" ? item.status : "running"
      steps.push({
        id: item.id,
        label: item.label,
        status,
        ...(typeof item.detail === "string" && item.detail ? { detail: item.detail } : {}),
        ...(typeof item.result === "string" && item.result ? { result: item.result } : {}),
      })
    }
    return steps
  } catch {
    return []
  }
}

function normalizeStatus(status: string): ChildAgentStatus {
  if (status === "SUCCEEDED" || status === "FAILED" || status === "INTERRUPTED") return status
  return "RUNNING"
}

type ParsedAgentEnvelope = {
  parentId: string | null
  blocks: Record<string, unknown>[]
}

function parseAgentPayload(payloadJson: string): ParsedAgentEnvelope | null {
  try {
    const envelope = JSON.parse(payloadJson) as {
      message?: { parent_tool_use_id?: unknown; message?: { content?: unknown } }
    } | null
    const content = envelope?.message?.message?.content
    if (!Array.isArray(content)) return null
    const parentId =
      typeof envelope?.message?.parent_tool_use_id === "string" && envelope.message.parent_tool_use_id.trim()
        ? envelope.message.parent_tool_use_id.trim()
        : null
    return { parentId, blocks: content as Record<string, unknown>[] }
  } catch {
    return null
  }
}

/**
 * Cheap pre-check so pure text-delta, status, or heartbeat batches skip querying `agent_child_runs` altogether.
 */
export function batchMayAffectChildRuns(
  events: readonly { type: string; payloadJson: string }[],
): { mayAffect: boolean; hasSubagentSpawn: boolean } {
  let mayAffect = false
  let hasSubagentSpawn = false

  for (const event of events) {
    if (event.type !== "agent") continue
    const parsed = parseAgentPayload(event.payloadJson)
    if (!parsed) continue
    if (parsed.parentId) mayAffect = true
    for (const raw of parsed.blocks) {
      if (raw?.type === "tool_use" && typeof raw.name === "string" && SUBAGENT_TOOLS.has(raw.name)) {
        mayAffect = true
        hasSubagentSpawn = true
      } else if (raw?.type === "tool_result") {
        mayAffect = true
      }
    }
  }

  return { mayAffect, hasSubagentSpawn }
}

type MutableChildRun = {
  id: string
  nativeAgentId: string
  parentChildRunId: string | null
  parentNativeAgentId: string | null
  role: string
  description: string
  status: ChildAgentStatus
  currentActivity: string | null
  stepCount: number
  steps: ToolStep[]
  resultSummary: string | null
  startedAt: Date
  finishedAt: Date | null
  isNew: boolean
  dirty: boolean
}

function latestRunningStepLabel(steps: readonly ToolStep[]): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.status === "running") {
      return clip(step.detail ? `${step.label} · ${step.detail}` : step.label, 240) || null
    }
  }
  return null
}

/**
 * Projects newly-accepted `AgentRunEvent`s into durable `AgentChildRun` rows inside `appendAgentRunEvents`.
 * Safe to call inside a transaction ONLY when guarded against unapplied schema (`P2021`/`P2022`) — note that
 * in plain PostgreSQL an aborted statement inside a transaction marks the transaction aborted, so callers
 * either run this after the main transaction commits or probe availability first.
 */
let childRunsAvailableCache: { value: boolean; checkedAt: number } | null = null
const NEGATIVE_PROBE_TTL_MS = 30_000

export async function agentChildRunsAvailable(prisma: ChildRunDbClient): Promise<boolean> {
  if (!prisma.agentChildRun) return false
  if (childRunsAvailableCache?.value) return true
  if (childRunsAvailableCache && Date.now() - childRunsAvailableCache.checkedAt < NEGATIVE_PROBE_TTL_MS) {
    return false
  }
  try {
    await prisma.agentChildRun.findMany({ take: 1, select: { id: true } })
    childRunsAvailableCache = { value: true, checkedAt: Date.now() }
    return true
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      childRunsAvailableCache = { value: false, checkedAt: Date.now() }
      return false
    }
    throw error
  }
}

export function resetAgentChildRunsAvailabilityCache(): void {
  childRunsAvailableCache = null
}

export async function syncAgentChildRunsForBatch(
  db: ChildRunDbClient,
  {
    runId,
    conversationId,
    workspaceId,
    events,
    redactArgs = false,
    now = new Date(),
  }: {
    runId: string
    conversationId: string
    workspaceId: string
    events: readonly { type: string; payloadJson: string }[]
    redactArgs?: boolean
    now?: Date
  },
): Promise<void> {
  if (!db.agentChildRun) return
  const { mayAffect, hasSubagentSpawn } = batchMayAffectChildRuns(events)
  if (!mayAffect) return

  let existingRows: {
    id: string
    nativeAgentId: string
    parentChildRunId: string | null
    parentNativeAgentId: string | null
    role: string
    description: string
    status: string
    currentActivity: string | null
    stepCount: number
    stepsJson: string | null
    resultSummary: string | null
    startedAt: Date
    finishedAt: Date | null
  }[]
  try {
    existingRows = await db.agentChildRun.findMany({
      where: { runId },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        nativeAgentId: true,
        parentChildRunId: true,
        parentNativeAgentId: true,
        role: true,
        description: true,
        status: true,
        currentActivity: true,
        stepCount: true,
        stepsJson: true,
        resultSummary: true,
        startedAt: true,
        finishedAt: true,
      },
    })
  } catch (error) {
    if (isMissingSchemaObject(error)) {
      childRunsAvailableCache = { value: false, checkedAt: Date.now() }
      return
    }
    throw error
  }

  if (existingRows.length === 0 && !hasSubagentSpawn) return

  const byNative = new Map<string, MutableChildRun>()
  for (const row of existingRows) {
    byNative.set(row.nativeAgentId, {
      id: row.id,
      nativeAgentId: row.nativeAgentId,
      parentChildRunId: row.parentChildRunId,
      parentNativeAgentId: row.parentNativeAgentId,
      role: row.role,
      description: row.description,
      status: normalizeStatus(row.status),
      currentActivity: row.currentActivity,
      stepCount: row.stepCount,
      steps: parseChildRunSteps(row.stepsJson),
      resultSummary: row.resultSummary,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      isNew: false,
      dirty: false,
    })
  }

  for (const event of events) {
    if (event.type !== "agent") continue
    const parsed = parseAgentPayload(event.payloadJson)
    if (!parsed) continue
    const { parentId, blocks } = parsed

    for (const raw of blocks) {
      if (raw?.type === "tool_use" && typeof raw.name === "string") {
        const rawId = typeof raw.id === "string" && raw.id.trim() ? clip(raw.id, 191) : ""
        if (!rawId) continue

        if (SUBAGENT_TOOLS.has(raw.name)) {
          const input = (raw.input ?? {}) as Record<string, unknown>
          const rawRole =
            typeof input.subagent_type === "string" && input.subagent_type.trim()
              ? input.subagent_type
              : typeof input.role === "string" && input.role.trim()
                ? input.role
                : "general-purpose"
          const role = clip(rawRole, 191) || "general-purpose"
          const description = redactArgs
            ? "Delegated sub-agent"
            : clip(typeof input.description === "string" && input.description.trim() ? input.description : "Subagent", 500) || "Subagent"
          const parentNative = parentId ? clip(parentId, 191) || null : null

          const existing = byNative.get(rawId)
          if (!existing) {
            byNative.set(rawId, {
              id: randomUUID(),
              nativeAgentId: rawId,
              parentChildRunId: null,
              parentNativeAgentId: parentNative,
              role,
              description,
              status: "RUNNING",
              currentActivity: null,
              stepCount: 0,
              steps: [],
              resultSummary: null,
              startedAt: now,
              finishedAt: null,
              isNew: true,
              dirty: true,
            })
          } else if (existing.parentNativeAgentId === null && parentNative) {
            existing.parentNativeAgentId = parentNative
            existing.dirty = true
          }
        } else if (parentId) {
          const owner = byNative.get(parentId)
          if (owner && !owner.steps.some((step) => step.id === rawId)) {
            const label = humanizeToolName(raw.name)
            const detail = redactArgs ? undefined : summarizeInput(raw.input)
            const nextStep: ToolStep = {
              id: rawId,
              label,
              status: "running",
              ...(detail ? { detail } : {}),
            }
            owner.stepCount += 1
            if (owner.steps.length < MAX_PERSISTED_CHILD_STEPS) {
              owner.steps = [...owner.steps, nextStep]
            } else {
              owner.steps = [...owner.steps.slice(1), nextStep]
            }
            if (owner.status === "RUNNING") {
              owner.currentActivity = clip(detail ? `${label} · ${detail}` : label, 240) || label
            }
            owner.dirty = true
          }
        }
      } else if (raw?.type === "tool_result") {
        const toolUseId = typeof raw.tool_use_id === "string" ? clip(raw.tool_use_id, 191) : ""
        if (!toolUseId) continue
        const isError = raw.is_error === true

        const settledAgent = byNative.get(toolUseId)
        if (settledAgent) {
          if (settledAgent.status === "RUNNING") {
            settledAgent.status = isError ? "FAILED" : "SUCCEEDED"
            settledAgent.currentActivity = null
            settledAgent.finishedAt = now
            settledAgent.steps = settledAgent.steps.map((step) =>
              step.status === "running" ? { ...step, status: isError ? ("error" as const) : ("done" as const) } : step,
            )
            if (!redactArgs) {
              settledAgent.resultSummary = extractResultText(raw.content, 2000) ?? settledAgent.resultSummary
            }
            settledAgent.dirty = true
          }
        } else if (parentId) {
          const owner = byNative.get(parentId)
          if (owner && owner.steps.some((step) => step.id === toolUseId && step.status === "running")) {
            const result = redactArgs ? undefined : extractResultText(raw.content, 600)
            owner.steps = owner.steps.map((step) =>
              step.id === toolUseId
                ? {
                    ...step,
                    status: isError ? ("error" as const) : ("done" as const),
                    ...(result ? { result } : {}),
                  }
                : step,
            )
            if (owner.status === "RUNNING") {
              owner.currentActivity = latestRunningStepLabel(owner.steps)
            }
            owner.dirty = true
          }
        }
      }
    }
  }

  // Resolve `parentChildRunId` for nested sub-agents whose parent is in this run's map.
  for (const entry of byNative.values()) {
    if (!entry.parentChildRunId && entry.parentNativeAgentId) {
      const parent = byNative.get(entry.parentNativeAgentId)
      if (parent && parent.id !== entry.id) {
        entry.parentChildRunId = parent.id
        entry.dirty = true
      }
    }
  }

  for (const entry of byNative.values()) {
    if (!entry.dirty) continue
    const stepsJson = JSON.stringify(entry.steps)
    if (entry.isNew) {
      try {
        await db.agentChildRun.create({
          select: { id: true },
          data: {
            id: entry.id,
            conversationId,
            runId,
            workspaceId,
            nativeAgentId: entry.nativeAgentId,
            parentChildRunId: entry.parentChildRunId,
            parentNativeAgentId: entry.parentNativeAgentId,
            role: entry.role,
            description: entry.description,
            status: entry.status,
            currentActivity: entry.currentActivity,
            stepCount: entry.stepCount,
            stepsJson,
            resultSummary: entry.resultSummary,
            startedAt: entry.startedAt,
            finishedAt: entry.finishedAt,
            createdAt: now,
            updatedAt: now,
          },
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          await db.agentChildRun.updateMany({
            where: { runId, nativeAgentId: entry.nativeAgentId },
            data: {
              parentChildRunId: entry.parentChildRunId,
              parentNativeAgentId: entry.parentNativeAgentId,
              role: entry.role,
              description: entry.description,
              status: entry.status,
              currentActivity: entry.currentActivity,
              stepCount: entry.stepCount,
              stepsJson,
              resultSummary: entry.resultSummary,
              finishedAt: entry.finishedAt,
              updatedAt: now,
            },
          })
        } else if (!isMissingSchemaObject(error)) {
          throw error
        }
      }
    } else {
      try {
        await db.agentChildRun.update({
          where: { id: entry.id },
          select: { id: true },
          data: {
            parentChildRunId: entry.parentChildRunId,
            parentNativeAgentId: entry.parentNativeAgentId,
            status: entry.status,
            currentActivity: entry.currentActivity,
            stepCount: entry.stepCount,
            stepsJson,
            resultSummary: entry.resultSummary,
            finishedAt: entry.finishedAt,
            updatedAt: now,
          },
        })
      } catch (error) {
        if (!isMissingSchemaObject(error)) throw error
      }
    }
  }
}

/**
 * Settles any `RUNNING` child runs left behind when their parent `AgentRun` reaches a terminal status.
 */
export async function settleStrandedAgentChildRuns(
  db: ChildRunDbClient,
  {
    runId,
    terminalRunStatus,
    now = new Date(),
  }: {
    runId: string
    terminalRunStatus: "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELED"
    now?: Date
  },
): Promise<void> {
  if (!db.agentChildRun) return
  const childStatus: ChildAgentStatus =
    terminalRunStatus === "SUCCEEDED"
      ? "SUCCEEDED"
      : terminalRunStatus === "FAILED"
        ? "FAILED"
        : "INTERRUPTED"
  try {
    const runningRows = await db.agentChildRun.findMany({
      where: { runId, status: "RUNNING" },
      select: { id: true, stepsJson: true },
    })
    if (runningRows.length === 0) return

    for (const row of runningRows) {
      const steps = parseChildRunSteps(row.stepsJson)
      const settledSteps = steps.map((step) =>
        step.status === "running"
          ? { ...step, status: childStatus === "FAILED" ? ("error" as const) : ("done" as const) }
          : step,
      )
      await db.agentChildRun.update({
        where: { id: row.id },
        select: { id: true },
        data: {
          status: childStatus,
          currentActivity: null,
          stepsJson: JSON.stringify(settledSteps),
          finishedAt: now,
          updatedAt: now,
        },
      })
    }
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
}

/**
 * Reads the durable child-agent runs for one conversation after enforcing `resolveConversationAccess`.
 * Returns `null` when the caller cannot access the conversation (404), or `[]` when migration 120 is unapplied.
 */
export async function listConversationChildRuns(
  prisma: Pick<AppPrismaClient, "agentConversation"> & ChildRunDbClient,
  {
    conversationId,
    workspaceId,
    userId,
  }: {
    conversationId: string
    workspaceId: string
    userId: string
  },
): Promise<SerializedChildAgentRun[] | null> {
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId })
  if (!access) return null
  if (!prisma.agentChildRun) return []

  try {
    const rows = await prisma.agentChildRun.findMany({
      where: { conversationId, workspaceId },
      orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        conversationId: true,
        runId: true,
        nativeAgentId: true,
        parentChildRunId: true,
        parentNativeAgentId: true,
        role: true,
        description: true,
        status: true,
        currentActivity: true,
        stepCount: true,
        stepsJson: true,
        resultSummary: true,
        startedAt: true,
        finishedAt: true,
        updatedAt: true,
      },
    })

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      runId: row.runId,
      nativeAgentId: row.nativeAgentId,
      parentChildRunId: row.parentChildRunId,
      parentNativeAgentId: row.parentNativeAgentId,
      role: row.role,
      description: row.description,
      status: normalizeStatus(row.status),
      currentActivity: row.currentActivity,
      stepCount: row.stepCount,
      steps: parseChildRunSteps(row.stepsJson),
      resultSummary: row.resultSummary,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    }))
  } catch (error) {
    if (isMissingSchemaObject(error)) return []
    throw error
  }
}

export type ChildAgentsSummaryByConversation = {
  total: number
  active: number
  failed: number
  roles: string[]
}

/**
 * Constant-count batch summary of child sub-agents across up to 100 board conversations.
 */
export async function loadChildAgentSummariesByConversation(
  prisma: ChildRunDbClient,
  workspaceId: string,
  conversationIds: readonly string[],
): Promise<Map<string, ChildAgentsSummaryByConversation>> {
  const result = new Map<string, ChildAgentsSummaryByConversation>()
  if (!prisma.agentChildRun || conversationIds.length === 0) return result

  try {
    const rows = await prisma.agentChildRun.findMany({
      where: { workspaceId, conversationId: { in: [...conversationIds] } },
      select: {
        conversationId: true,
        role: true,
        description: true,
        status: true,
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: 1000,
    })

    for (const row of rows) {
      let entry = result.get(row.conversationId)
      if (!entry) {
        entry = { total: 0, active: 0, failed: 0, roles: [] }
        result.set(row.conversationId, entry)
      }
      entry.total += 1
      const status = normalizeStatus(row.status)
      if (status === "RUNNING") entry.active += 1
      else if (status === "FAILED") entry.failed += 1
      const label = agentLabel({ role: row.role, description: row.description })
      if (label && !entry.roles.includes(label) && entry.roles.length < 8) {
        entry.roles.push(label)
      }
    }
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }

  return result
}

/** Workspace-deletion cleanup (`relationMode = "prisma"` does not DB-cascade). */
export async function deleteWorkspaceAgentChildRuns(
  prisma: ChildRunDbClient,
  workspaceId: string,
): Promise<void> {
  if (!prisma.agentChildRun) return
  try {
    await prisma.agentChildRun.deleteMany({ where: { workspaceId } })
  } catch (error) {
    if (!isMissingSchemaObject(error)) throw error
  }
}
