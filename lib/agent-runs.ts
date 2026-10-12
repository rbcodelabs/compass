/**
 * Control plane for durable, detachable agent runs.
 *
 * An agent turn used to be an HTTP request that happened to have a sandbox
 * attached to it. It is now a *run*: a row that owns the lifecycle, an
 * append-only event log that owns the transcript, and a worker credential that
 * lets the sandbox report in from outside any request. The browser becomes an
 * optional viewer.
 *
 * The shape here deliberately mirrors `lib/research-voice-control-plane.ts` —
 * worker token hashed into a unique column, lease + heartbeat, ordinal-keyed
 * idempotent ingestion, optimistic-concurrency fences on every mutation, and a
 * single termination path that both the happy case and the sweeper go through.
 * That is the house precedent for "a process outside the request writes to our
 * database", and there is no reason for a second dialect of it.
 *
 * Three properties are load-bearing and worth stating outright:
 *
 *  1. **Event ingestion is idempotent on `(runId, seq)`.** A retried batch
 *     collides on the unique index instead of doubling the transcript. This is
 *     why the worker can retry a failed POST without coordination.
 *  2. **Terminal transitions are first-write-wins.** The status is claimed with
 *     an `updateMany` fenced on a non-terminal status *before* any side effect
 *     runs, so a late duplicate result and a concurrent sweep cannot both write
 *     an assistant message, revoke a key twice, or resurrect a finished run.
 *  3. **Audit rows are written at accept time**, not from an in-memory array in
 *     a `finally`. The event insert is the idempotency gate, so deriving audit
 *     rows from newly-accepted events inherits exactly-once from it.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import type { AppPrismaClient } from "@/lib/db"
import { bareToolName, isMutationTool } from "@/lib/agent-mutations"
import { HANDOFF_POLICIES } from "@/lib/agent-handoff-kinds"
import { HANDOFF_KINDS, type HandoffKind } from "@/lib/pm-agent-processing"
import { revokeAgentMcpKey } from "@/lib/agent-mcp-key"
import { finishInterviewProcessing, reportPmAgentFailure } from "@/lib/pm-agent-service"
import { stopSandboxByName } from "@/lib/agent-sandbox"

// ── Budgets and caps ────────────────────────────────────────────────────────
//
// These are code constants rather than `AgentRuntimeConfig` columns: changing a
// run budget is a deploy-scale decision, and an extra DSQL `ALTER TABLE` buys
// nothing when the value can only be edited by someone who can also redeploy.

/** Default wall-clock budget for one run. */
export const DEFAULT_AGENT_RUN_BUDGET_MS = 20 * 60_000
/** Hard ceiling a caller may request. Well inside the platform's 24h sandbox cap. */
export const MAX_AGENT_RUN_BUDGET_MS = 60 * 60_000
/** Floor, so a caller cannot ask for a budget that expires before the boot finishes. */
export const MIN_AGENT_RUN_BUDGET_MS = 60_000

/** How often the worker is expected to report in. */
/** Model recorded on a finished run; matches what the turn entry script runs. */
export const AGENT_RUN_MODEL_ID = "claude-sonnet-5"
export const AGENT_RUN_HEARTBEAT_MS = 15_000
/**
 * How stale a heartbeat has to be before the sweeper calls the run dead.
 *
 * A margin of 3× the interval (45s) was considered and rejected; 6× is used instead: the sweeper's own
 * cron granularity is 60s, so a 45s margin is *narrower than one tick* of the
 * thing enforcing it — a single slow flush on a healthy run would be
 * indistinguishable from a dead worker. The deadline check is independent and
 * unaffected, so the cost of the wider margin is only how long a genuinely dead
 * run sits `RUNNING`.
 */
export const AGENT_RUN_HEARTBEAT_TIMEOUT_MS = 6 * AGENT_RUN_HEARTBEAT_MS

/** Per-run caps. Refusing an absurd transcript is the 1 MB transport guard's job, generalized. */
export const MAX_AGENT_RUN_EVENTS = 2_000
export const MAX_AGENT_RUN_PAYLOAD_BYTES = 4 * 1024 * 1024
/** Per-callback caps. The worker flushes on whichever bound it hits first. */
export const MAX_AGENT_RUN_CALLBACK_EVENTS = 32
export const MAX_AGENT_RUN_CALLBACK_BYTES = 256 * 1024

export const AGENT_RUN_STATUSES = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

export const NON_TERMINAL_AGENT_RUN_STATUSES = ["QUEUED", "RUNNING"] as const satisfies readonly AgentRunStatus[]
const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRunStatus>(["SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELED"])

export function isTerminalAgentRunStatus(status: string) {
  return TERMINAL_AGENT_RUN_STATUSES.has(status as AgentRunStatus)
}

export const AGENT_RUN_EVENT_TYPES = ["status", "agent", "result", "error", "heartbeat"] as const
export type AgentRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number]

/** `CHAT` is an ordinary conversation turn; anything else is an ADR-0012 handoff. */
export type AgentRunKind = "CHAT" | HandoffKind

export class AgentRunError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = "AgentRunError"
  }
}

// ── Worker credential ───────────────────────────────────────────────────────

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function hashAgentRunWorkerToken(rawToken: string) {
  return sha256(rawToken)
}

/**
 * A dedicated worker credential, *not* the run's `cmp_` MCP key.
 *
 * Reusing the MCP key would mean one stolen value both writes the transcript and
 * acts as the user against every Compass tool. Splitting them costs one column
 * and keeps the callback channel's blast radius to "can forge this run's
 * transcript". 43 chars of base64url, matching the voice worker token so the
 * bearer regex is shared.
 */
export function createAgentRunCredential() {
  const rawToken = randomBytes(32).toString("base64url")
  return { rawToken, tokenHash: hashAgentRunWorkerToken(rawToken) }
}

export function agentRunWorkerTokenIsBound({
  rawToken,
  expectedTokenHash,
  status,
  deadlineAt,
  now,
}: {
  rawToken: string
  expectedTokenHash: string
  status: string
  deadlineAt: Date
  now: Date
}) {
  if (isTerminalAgentRunStatus(status) || now >= deadlineAt || !/^[a-f0-9]{64}$/.test(expectedTokenHash)) return false
  const actual = Buffer.from(hashAgentRunWorkerToken(rawToken), "hex")
  const expected = Buffer.from(expectedTokenHash, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Sandbox name, derived from the run id rather than stored-then-read.
 *
 * `Sandbox.get` is keyed by *name*, not id, so a derivable name means the
 * sweeper can reach a sandbox even when the start path died between booting it
 * and persisting the column.
 */
export function agentRunSandboxName(runId: string) {
  return `compass-agent-run-${runId}`
}

export function resolveAgentRunBudgetMs(requestedMs?: unknown) {
  if (requestedMs === undefined || requestedMs === null) return DEFAULT_AGENT_RUN_BUDGET_MS
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs)) {
    throw new AgentRunError("Invalid agent run budget", 400, "INVALID_BUDGET")
  }
  return Math.min(MAX_AGENT_RUN_BUDGET_MS, Math.max(MIN_AGENT_RUN_BUDGET_MS, Math.floor(requestedMs)))
}

// ── Pre-migration fallback probe ────────────────────────────────────────────

let availabilityCache: { value: boolean; checkedAt: number } | null = null
/** A positive result is permanent; a negative one is re-probed, so applying the migration needs no redeploy. */
const AVAILABILITY_NEGATIVE_TTL_MS = 30_000

/**
 * Whether `069_background_agent_runs` has been applied to the active schema.
 *
 * The code must survive being deployed before its
 * migration is applied, so the turn route falls back to the synchronous path
 * when this is false. Mirrors `workspaceUpdatesAvailable`: Prisma reports a
 * missing table as `P2021`, and anything else is a real fault worth surfacing.
 */
export async function agentRunsAvailable(prisma: AppPrismaClient): Promise<boolean> {
  if (availabilityCache?.value) return true
  if (availabilityCache && Date.now() - availabilityCache.checkedAt < AVAILABILITY_NEGATIVE_TTL_MS) return false
  try {
    await Promise.all([
      prisma.agentRun.findFirst({ select: { id: true } }),
      prisma.agentRunEvent.findFirst({ select: { id: true } }),
    ])
    availabilityCache = { value: true, checkedAt: Date.now() }
    return true
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2021") {
      availabilityCache = { value: false, checkedAt: Date.now() }
      return false
    }
    throw error
  }
}

/** Test seam: forget the probe result so a suite can exercise both branches. */
export function resetAgentRunsAvailabilityCache() {
  availabilityCache = null
}

// ── Creation ───────────────────────────────────────────────────────────────

type AgentRunPrisma = Pick<AppPrismaClient, "$transaction">

export async function createAgentRun({
  prisma,
  conversationId,
  workspaceId,
  userId,
  kind = "CHAT",
  claimId = null,
  packProvenance = "[]",
  budgetMs = DEFAULT_AGENT_RUN_BUDGET_MS,
  now = new Date(),
}: {
  prisma: AgentRunPrisma
  conversationId: string
  workspaceId: string
  userId: string
  kind?: AgentRunKind
  claimId?: string | null
  packProvenance?: string
  budgetMs?: number
  now?: Date
}) {
  if (kind !== "CHAT" && !(HANDOFF_KINDS as readonly string[]).includes(kind)) {
    throw new AgentRunError("Unsupported agent run kind", 400, "INVALID_RUN_KIND")
  }
  const deadlineAt = new Date(now.getTime() + resolveAgentRunBudgetMs(budgetMs))
  const credential = createAgentRunCredential()
  const runId = randomUUID()

  const run = await prisma.$transaction(async (tx) => {
    // At most one non-terminal run per conversation, enforced on the write path.
    // A partial unique index would be stronger, but DSQL's support for predicate
    // indexes is unverified here and `assertWorkspaceUpdatesMigration` asserts
    // `predicate === null` on every unique index this repo ships — so this stays
    // an application invariant, checked inside the transaction that violates it.
    const inFlight = await tx.agentRun.findFirst({
      where: { conversationId, status: { in: [...NON_TERMINAL_AGENT_RUN_STATUSES] } },
      select: { id: true, status: true, deadlineAt: true },
    })
    if (inFlight) {
      throw new AgentRunError("An agent run is already in flight for this conversation", 409, "RUN_IN_FLIGHT")
    }
    return tx.agentRun.create({
      data: {
        id: runId,
        conversationId,
        workspaceId,
        userId,
        status: "QUEUED",
        kind,
        workerTokenHash: credential.tokenHash,
        claimId,
        packProvenance,
        deadlineAt,
        statusChangedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    })
  })

  return { run, workerToken: credential.rawToken, sandboxName: agentRunSandboxName(run.id) }
}

/**
 * QUEUED → RUNNING, once the sandbox is booted and the command is away.
 *
 * `apiKeyId` and `sandboxName` are recorded here rather than at creation
 * because until this point there is nothing to revoke or stop. A run that never
 * reaches this call is collected by the sweeper off `statusChangedAt`.
 */
export async function markAgentRunStarted({
  prisma,
  runId,
  apiKeyId,
  sandboxName,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  runId: string
  apiKeyId?: string | null
  sandboxName?: string | null
  now?: Date
}) {
  const started = await prisma.agentRun.updateMany({
    where: { id: runId, status: "QUEUED" },
    data: {
      status: "RUNNING",
      apiKeyId: apiKeyId ?? null,
      sandboxName: sandboxName ?? agentRunSandboxName(runId),
      startedAt: now,
      lastHeartbeatAt: now,
      statusChangedAt: now,
      updatedAt: now,
    },
  })
  return started.count === 1
}

// ── Callback authorization ─────────────────────────────────────────────────

const AGENT_RUN_AUTH_SELECT = {
  id: true,
  conversationId: true,
  workspaceId: true,
  userId: true,
  status: true,
  kind: true,
  claimId: true,
  apiKeyId: true,
  sandboxName: true,
  packProvenance: true,
  workerTokenHash: true,
  deadlineAt: true,
  lastSeq: true,
  eventCount: true,
  payloadBytes: true,
} as const

export async function authorizeAgentRunWorker({
  prisma,
  runId,
  rawToken,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  runId: string
  rawToken: string
  now?: Date
}) {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: AGENT_RUN_AUTH_SELECT })
  // A wrong id and a wrong token are both 401: distinguishing them would tell an
  // unauthenticated caller which run ids exist.
  if (!run || !agentRunWorkerTokenIsBound({
    rawToken,
    expectedTokenHash: run.workerTokenHash,
    status: run.status,
    deadlineAt: run.deadlineAt,
    now,
  })) {
    throw new AgentRunError("Invalid agent run worker token", 401, "INVALID_WORKER_TOKEN")
  }
  return run
}

// ── Event ingestion ────────────────────────────────────────────────────────

export type IncomingAgentRunEvent = {
  seq: number
  type: AgentRunEventType
  payload: unknown
}

function validateAgentRunBatch(events: IncomingAgentRunEvent[]) {
  if (events.length === 0 || events.length > MAX_AGENT_RUN_CALLBACK_EVENTS) {
    throw new AgentRunError("Agent run callback batch is out of range", 413, "CALLBACK_BATCH_TOO_LARGE")
  }
  const seqs = new Set<number>()
  let bytes = 0
  const serialized = events.map((event) => {
    if (!Number.isInteger(event.seq) || event.seq < 1) {
      throw new AgentRunError("Agent run event sequence must be a positive integer", 400, "INVALID_EVENT_SEQ")
    }
    if (seqs.has(event.seq)) {
      throw new AgentRunError("Agent run callback batch repeats a sequence", 409, "DUPLICATE_EVENT_SEQ")
    }
    seqs.add(event.seq)
    if (!(AGENT_RUN_EVENT_TYPES as readonly string[]).includes(event.type)) {
      throw new AgentRunError("Unknown agent run event type", 400, "INVALID_EVENT_TYPE")
    }
    const payloadJson = JSON.stringify(event.payload ?? null)
    bytes += Buffer.byteLength(payloadJson, "utf8")
    return { seq: event.seq, type: event.type, payloadJson }
  })
  if (bytes > MAX_AGENT_RUN_CALLBACK_BYTES) {
    throw new AgentRunError("Agent run callback payload is too large", 413, "CALLBACK_PAYLOAD_TOO_LARGE")
  }
  return { serialized, bytes }
}

/**
 * Mutating tool calls the agent made, read out of an `agent` event.
 *
 * Same block shape and same 1000-char args truncation the turn route used, so
 * the audit table's contents do not change meaning — only when they are written.
 * `redactArgs` mirrors the old `scope ? null : …`: a claimed handoff turn records
 * that a tool ran without recording its arguments.
 */
export function deriveAgentRunAuditRows(payload: unknown, redactArgs: boolean) {
  const rows: { toolName: string; argsSummary: string | null }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = ((payload as any)?.message?.message?.content ?? []) as any[]
  if (!Array.isArray(content)) return rows
  for (const block of content) {
    if (block?.type === "tool_use" && typeof block.name === "string" && isMutationTool(block.name)) {
      rows.push({
        toolName: bareToolName(block.name),
        argsSummary: redactArgs ? null : block.input ? JSON.stringify(block.input).slice(0, 1000) : null,
      })
    }
  }
  return rows
}

export async function appendAgentRunEvents({
  prisma,
  runId,
  rawToken,
  events,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  runId: string
  rawToken: string
  events: IncomingAgentRunEvent[]
  now?: Date
}) {
  const { serialized } = validateAgentRunBatch(events)

  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({ where: { id: runId }, select: AGENT_RUN_AUTH_SELECT })
    if (!run || !agentRunWorkerTokenIsBound({
      rawToken,
      expectedTokenHash: run.workerTokenHash,
      status: run.status,
      deadlineAt: run.deadlineAt,
      now,
    })) {
      throw new AgentRunError("Invalid agent run worker token", 401, "INVALID_WORKER_TOKEN")
    }

    // Already-present sequences are replays, not errors — that is the whole
    // point of the unique index. Read them first so audit rows are derived from
    // *newly accepted* events only, without needing one insert per event to find
    // out which those were.
    const existing = await tx.agentRunEvent.findMany({
      where: { runId, seq: { in: serialized.map((event) => event.seq) } },
      select: { seq: true },
    })
    const seen = new Set(existing.map((row) => row.seq))
    const fresh = serialized.filter((event) => !seen.has(event.seq))
    const replayedSeqs = serialized.filter((event) => seen.has(event.seq)).map((event) => event.seq)
    if (fresh.length === 0) {
      return { acceptedSeqs: [] as number[], replayedSeqs, lastSeq: run.lastSeq, status: run.status as AgentRunStatus }
    }

    const freshBytes = fresh.reduce((total, event) => total + Buffer.byteLength(event.payloadJson, "utf8"), 0)
    if (run.eventCount + fresh.length > MAX_AGENT_RUN_EVENTS || run.payloadBytes + freshBytes > MAX_AGENT_RUN_PAYLOAD_BYTES) {
      throw new AgentRunError("Agent run event budget exhausted", 409, "RUN_EVENT_LIMIT")
    }

    await tx.agentRunEvent.createMany({
      data: fresh.map((event) => ({ runId, seq: event.seq, type: event.type, payloadJson: event.payloadJson, createdAt: now })),
      skipDuplicates: true,
    })

    const nextLastSeq = Math.max(run.lastSeq, ...fresh.map((event) => event.seq))
    const advanced = await tx.agentRun.updateMany({
      where: {
        id: runId,
        status: run.status,
        lastSeq: run.lastSeq,
        eventCount: run.eventCount,
        payloadBytes: run.payloadBytes,
      },
      data: {
        lastSeq: nextLastSeq,
        eventCount: run.eventCount + fresh.length,
        payloadBytes: run.payloadBytes + freshBytes,
        lastHeartbeatAt: now,
        updatedAt: now,
      },
    })
    if (advanced.count !== 1) {
      throw new AgentRunError("Agent run callback changed concurrently", 409, "CALLBACK_RACE")
    }

    const auditRows = fresh
      .filter((event) => event.type === "agent")
      .flatMap((event) => deriveAgentRunAuditRows(JSON.parse(event.payloadJson), Boolean(run.claimId)))
    if (auditRows.length > 0) {
      await tx.agentAuditLog.createMany({
        data: auditRows.map((row) => ({
          userId: run.userId,
          workspaceId: run.workspaceId,
          conversationId: run.conversationId,
          toolName: row.toolName,
          argsSummary: row.argsSummary,
          packProvenance: run.packProvenance ?? "[]",
        })),
      })
    }

    return {
      acceptedSeqs: fresh.map((event) => event.seq),
      replayedSeqs,
      lastSeq: nextLastSeq,
      status: run.status as AgentRunStatus,
    }
  })
}

export async function recordAgentRunHeartbeat({
  prisma,
  runId,
  rawToken,
  now = new Date(),
}: {
  prisma: AppPrismaClient
  runId: string
  rawToken: string
  now?: Date
}) {
  const run = await authorizeAgentRunWorker({ prisma, runId, rawToken, now })
  const beat = await prisma.agentRun.updateMany({
    where: { id: runId, status: run.status, deadlineAt: { gt: now } },
    data: { lastHeartbeatAt: now, updatedAt: now },
  })
  if (beat.count !== 1) throw new AgentRunError("Agent run heartbeat changed concurrently", 409, "HEARTBEAT_RACE")
  // Echoing status + lastSeq lets a worker notice it has been canceled or swept
  // and stop burning model spend without a second endpoint.
  return { status: run.status as AgentRunStatus, lastSeq: run.lastSeq, deadlineAt: run.deadlineAt }
}

// ── Termination ────────────────────────────────────────────────────────────

export type AgentRunUsage = {
  durationMs?: number | null
  numTurns?: number | null
  totalCostUsd?: number | null
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null
}

export type AgentRunCleanup = {
  stopSandbox?: (sandboxName: string) => Promise<void>
  revokeKey?: (apiKeyId: string) => Promise<void>
  finishClaim?: (conversationId: string, claimId: string, successful: boolean) => Promise<void>
}

const defaultCleanup: Required<AgentRunCleanup> = {
  stopSandbox: (sandboxName) => stopSandboxByName(sandboxName),
  revokeKey: (apiKeyId) => revokeAgentMcpKey(apiKeyId),
  finishClaim: async (conversationId, claimId, successful) => {
    await finishInterviewProcessing(conversationId, claimId, successful)
  },
}

/** The message a user sees in the transcript for a run that did not succeed. */
export function agentRunFailureMessage(kind: string, status: AgentRunStatus, error?: string | null) {
  if (kind !== "CHAT" && (HANDOFF_KINDS as readonly string[]).includes(kind)) {
    return HANDOFF_POLICIES[kind as HandoffKind].failureMessage
  }
  const detail = error?.trim() || "no further detail was reported"
  return status === "INTERRUPTED"
    ? `Agent run was interrupted: ${detail}`
    : status === "CANCELED"
      ? "Agent run was canceled."
      : `Agent turn failed: ${detail}`
}

/**
 * Bring a run to a terminal status exactly once, then run its side effects.
 *
 * Ordering is the point: the status is claimed with a fenced `updateMany` before
 * the assistant message is written, the claim is finished, the key is revoked, or
 * the sandbox is stopped. Whoever loses that race returns `finalized: false` and
 * touches nothing, so a duplicate `result` delivery racing the sweeper cannot
 * produce two transcript entries or two revocations.
 *
 * This function *is* the replacement for the old `finally` block — which only
 * ever ran because a browser happened to still be connected.
 */
export async function finalizeAgentRun({
  prisma,
  runId,
  rawToken,
  status,
  text,
  usage,
  error,
  errorCode,
  now = new Date(),
  cleanup,
}: {
  prisma: AppPrismaClient
  runId: string
  rawToken?: string
  status: Extract<AgentRunStatus, "SUCCEEDED" | "FAILED" | "INTERRUPTED" | "CANCELED">
  text?: string | null
  usage?: AgentRunUsage | null
  error?: string | null
  errorCode?: string | null
  now?: Date
  cleanup?: AgentRunCleanup
}) {
  const effects = { ...defaultCleanup, ...cleanup }
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: AGENT_RUN_AUTH_SELECT })
  if (!run) throw new AgentRunError("Agent run not found", 404, "RUN_NOT_FOUND")
  if (rawToken !== undefined) {
    // A worker finishing its own run must still hold a valid token. The deadline
    // is deliberately *not* part of that check here — a run that overran by
    // seconds should be allowed to record its result rather than be swept.
    const actual = Buffer.from(hashAgentRunWorkerToken(rawToken), "hex")
    const expected = Buffer.from(run.workerTokenHash, "hex")
    if (!/^[a-f0-9]{64}$/.test(run.workerTokenHash) || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AgentRunError("Invalid agent run worker token", 401, "INVALID_WORKER_TOKEN")
    }
  }
  if (isTerminalAgentRunStatus(run.status)) {
    return { finalized: false as const, status: run.status as AgentRunStatus }
  }

  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, status: { in: [...NON_TERMINAL_AGENT_RUN_STATUSES] } },
    data: {
      status,
      error: error ?? null,
      errorCode: errorCode ?? null,
      model: status === "SUCCEEDED" ? AGENT_RUN_MODEL_ID : null,
      inputTokens: usage?.usage?.input_tokens ?? null,
      outputTokens: usage?.usage?.output_tokens ?? null,
      numTurns: usage?.numTurns ?? null,
      costUsd: usage?.totalCostUsd ?? null,
      durationMs: usage?.durationMs ?? null,
      finishedAt: now,
      statusChangedAt: now,
      updatedAt: now,
    },
  })
  if (claimed.count !== 1) {
    const current = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } })
    return { finalized: false as const, status: (current?.status ?? run.status) as AgentRunStatus }
  }

  // ── Side effects. Each is best-effort and independently guarded: a failure to
  // stop a sandbox must not prevent the key from being revoked, and neither may
  // leave the run looking unfinished.
  const content = status === "SUCCEEDED" ? (text ?? "") : agentRunFailureMessage(run.kind, status, error)
  try {
    await prisma.agentMessage.create({
      data: {
        conversationId: run.conversationId,
        role: "assistant",
        content,
        ...(status === "SUCCEEDED"
          ? {
              model: AGENT_RUN_MODEL_ID,
              inputTokens: usage?.usage?.input_tokens ?? null,
              outputTokens: usage?.usage?.output_tokens ?? null,
              numTurns: usage?.numTurns ?? null,
              costUsd: usage?.totalCostUsd ?? null,
              durationMs: usage?.durationMs ?? null,
            }
          : {}),
        packProvenance: run.packProvenance ?? "[]",
      },
    })
    await prisma.agentConversation.update({ where: { id: run.conversationId }, data: { updatedAt: now } })
  } catch {
    /* transcript history is best-effort; cleanup below still has to run */
  }

  if (run.claimId) {
    if (status !== "SUCCEEDED") {
      try { reportPmAgentFailure(run.conversationId, run.claimId, "execute", new Error(error ?? status)) } catch { /* diagnostic only */ }
    }
    try { await effects.finishClaim(run.conversationId, run.claimId, status === "SUCCEEDED") } catch { /* best-effort */ }
  }
  if (run.apiKeyId) {
    try { await effects.revokeKey(run.apiKeyId) } catch { /* revokeAgentMcpKey never throws, but the seam might */ }
  }
  try {
    await effects.stopSandbox(run.sandboxName ?? agentRunSandboxName(runId))
    await prisma.agentRun.update({ where: { id: runId }, data: { sandboxStoppedAt: now, updatedAt: now } })
  } catch {
    /* A sandbox that is already gone, or unreachable, still hits its own
       platform-side `timeoutMs`; leaving sandboxStoppedAt null records that we
       could not confirm it. */
  }

  return { finalized: true as const, status }
}

export async function cancelAgentRun({
  prisma,
  runId,
  userId,
  now = new Date(),
  cleanup,
}: {
  prisma: AppPrismaClient
  runId: string
  userId: string
  now?: Date
  cleanup?: AgentRunCleanup
}) {
  const run = await prisma.agentRun.findFirst({ where: { id: runId, userId }, select: { id: true } })
  if (!run) throw new AgentRunError("Agent run not found", 404, "RUN_NOT_FOUND")
  return finalizeAgentRun({
    prisma,
    runId,
    status: "CANCELED",
    error: "Canceled by the user",
    errorCode: "USER_CANCELED",
    now,
    cleanup,
  })
}

// ── Sweeper ────────────────────────────────────────────────────────────────

/**
 * Collect runs nobody is watching.
 *
 * Two independent conditions, deliberately: a passed `deadlineAt` terminates a
 * run even if heartbeats are somehow still arriving, and a stale heartbeat
 * terminates one whose worker died long before its deadline. `statusChangedAt`
 * stands in for the heartbeat on a `QUEUED` run, which is how an orphan from a
 * start path that crashed mid-boot gets collected.
 */
export async function sweepAgentRuns({
  prisma,
  now = new Date(),
  limit = 25,
  heartbeatTimeoutMs = AGENT_RUN_HEARTBEAT_TIMEOUT_MS,
  cleanup,
}: {
  prisma: AppPrismaClient
  now?: Date
  limit?: number
  heartbeatTimeoutMs?: number
  cleanup?: AgentRunCleanup
}) {
  const staleBefore = new Date(now.getTime() - heartbeatTimeoutMs)
  const candidates = await prisma.agentRun.findMany({
    where: {
      status: { in: [...NON_TERMINAL_AGENT_RUN_STATUSES] },
      OR: [
        { deadlineAt: { lte: now } },
        { lastHeartbeatAt: { lte: staleBefore } },
        { lastHeartbeatAt: null, statusChangedAt: { lte: staleBefore } },
      ],
    },
    orderBy: { statusChangedAt: "asc" },
    take: limit,
    select: { id: true, deadlineAt: true, lastHeartbeatAt: true, statusChangedAt: true },
  })

  const swept: { runId: string; reason: string }[] = []
  const failed: { runId: string; error: string }[] = []
  for (const candidate of candidates) {
    const reason = candidate.deadlineAt <= now ? "DEADLINE_EXPIRED" : "HEARTBEAT_STALE"
    try {
      const result = await finalizeAgentRun({
        prisma,
        runId: candidate.id,
        status: "INTERRUPTED",
        error: reason === "DEADLINE_EXPIRED"
          ? "The run exceeded its time budget."
          : "The run stopped reporting in and was assumed dead.",
        errorCode: reason,
        now,
        cleanup,
      })
      if (result.finalized) swept.push({ runId: candidate.id, reason })
    } catch (error) {
      failed.push({ runId: candidate.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  // `examined` vs `swept` is how a caller sees that `limit` truncated the batch
  // rather than that there was nothing left to do.
  return { examined: candidates.length, swept, failed, truncated: candidates.length === limit }
}

// ── Viewer reads ───────────────────────────────────────────────────────────

/**
 * Authorize a session user to watch a run.
 *
 * Ownership of the run is not sufficient on its own: workspace membership is
 * re-checked so someone removed from a workspace mid-run loses the transcript
 * with it, matching how the turn route authorizes.
 */
export async function getAgentRunForViewer({
  prisma,
  runId,
  userId,
}: {
  prisma: AppPrismaClient
  runId: string
  userId: string
}) {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, userId },
    select: {
      id: true,
      conversationId: true,
      workspaceId: true,
      status: true,
      kind: true,
      lastSeq: true,
      eventCount: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      numTurns: true,
      costUsd: true,
      durationMs: true,
      error: true,
      errorCode: true,
      deadlineAt: true,
      lastHeartbeatAt: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  })
  if (!run) return null
  const member = await prisma.workspace.findFirst({
    where: { id: run.workspaceId, members: { some: { userId } } },
    select: { id: true },
  })
  return member ? run : null
}

export async function listAgentRunEvents({
  prisma,
  runId,
  afterSeq = 0,
  take = 200,
}: {
  prisma: AppPrismaClient
  runId: string
  afterSeq?: number
  take?: number
}) {
  return prisma.agentRunEvent.findMany({
    where: { runId, seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
    take: Math.min(Math.max(take, 1), MAX_AGENT_RUN_CALLBACK_EVENTS * 20),
    select: { seq: true, type: true, payloadJson: true, createdAt: true },
  })
}

/** The in-flight run for a conversation, so a reopened tab can reattach. */
export async function findActiveAgentRun({
  prisma,
  conversationId,
}: {
  prisma: AppPrismaClient
  conversationId: string
}) {
  return prisma.agentRun.findFirst({
    where: { conversationId, status: { in: [...NON_TERMINAL_AGENT_RUN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, lastSeq: true, deadlineAt: true, createdAt: true },
  })
}
