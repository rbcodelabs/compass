/**
 * Control plane for agent control of the user's live UI.
 *
 * An MCP call cannot hold a connection to a browser tab, so the database is the
 * rendezvous: the agent inserts a `UiCommand`, the opted-in tab drains pending
 * commands over SSE, and posts the result back. This module owns every state
 * transition so the routes and the MCP tools stay thin.
 *
 * Load-bearing properties:
 *  1. **Opt-in is the authority.** A command can only target an ACTIVE,
 *     unexpired `UiSession` of the *same user and workspace* as the caller.
 *  2. **Navigation is confined.** Only same-origin paths under the workspace
 *     base path are accepted — validated here and again in the browser.
 *  3. **Delivery and completion are single-shot.** Each is an `updateMany`
 *     fenced on the prior status, so a tab reconnecting mid-command cannot run
 *     it twice and a late duplicate result cannot overwrite the first.
 */

import type { AppPrismaClient } from "@/lib/db"

export const UI_COMMAND_KINDS = ["navigate", "screenshot", "get_state"] as const
export type UiCommandKind = (typeof UI_COMMAND_KINDS)[number]

/** A session lapses this long after its last heartbeat. */
export const UI_SESSION_TTL_MS = 2 * 60_000
/** How long an agent call waits for the tab before giving up. */
export const UI_COMMAND_WAIT_MS = 25_000
/** A command not picked up / completed within this window is EXPIRED. */
export const UI_COMMAND_TTL_MS = 40_000
/** Screenshot payload ceiling (base64 characters of the PNG). */
export const UI_SCREENSHOT_MAX_BASE64 = 1_500_000
const RESULT_MAX_CHARS = UI_SCREENSHOT_MAX_BASE64 + 4_000
const POLL_MS = 400

export class UiControlError extends Error {
  constructor(
    message: string,
    readonly code: "NO_SESSION" | "INVALID" | "TIMEOUT" | "REJECTED" | "NOT_FOUND",
  ) {
    super(message)
    this.name = "UiControlError"
  }
}

// ── Navigation validation ────────────────────────────────────────────────

/**
 * Resolve a requested destination to a safe same-origin path inside the
 * workspace, or throw. Accepts a path ("/org/ws/roadmap?x=1") only; absolute
 * URLs, protocol-relative URLs, backslashes, control characters and anything
 * outside `basePath` are refused. Dot segments are resolved before the prefix
 * check so `/org/ws/../other` cannot escape.
 */
export function resolveNavigationPath(requested: string, basePath: string): string {
  const raw = requested.trim()
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    throw new UiControlError("Path must start with a single '/' (same-origin path only).", "INVALID")
  }
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) {
    throw new UiControlError("Path contains forbidden characters.", "INVALID")
  }
  let url: URL
  try {
    url = new URL(raw, "http://compass.invalid")
  } catch {
    throw new UiControlError("Path is not a valid URL path.", "INVALID")
  }
  if (url.origin !== "http://compass.invalid") {
    throw new UiControlError("Path must be same-origin.", "INVALID")
  }
  const base = basePath.replace(/\/+$/, "")
  const within = url.pathname === base || url.pathname.startsWith(`${base}/`)
  if (!within) {
    throw new UiControlError(`Navigation is limited to this workspace (${base}).`, "INVALID")
  }
  return `${url.pathname}${url.search}${url.hash}`
}

// ── Sessions (browser side) ──────────────────────────────────────────────

const TAB_ID = /^[A-Za-z0-9_-]{8,64}$/
export const isValidTabId = (value: unknown): value is string => typeof value === "string" && TAB_ID.test(value)

export async function startUiSession(args: {
  prisma: AppPrismaClient
  userId: string
  workspaceId: string
  tabId: string
  currentPath?: string | null
  now?: Date
}) {
  const now = args.now ?? new Date()
  const expiresAt = new Date(now.getTime() + UI_SESSION_TTL_MS)
  const data = {
    status: "ACTIVE",
    currentPath: args.currentPath?.slice(0, 500) ?? null,
    lastSeenAt: now,
    expiresAt,
    endedAt: null,
  }
  return args.prisma.uiSession.upsert({
    where: { userId_workspaceId_tabId: { userId: args.userId, workspaceId: args.workspaceId, tabId: args.tabId } },
    create: { userId: args.userId, workspaceId: args.workspaceId, tabId: args.tabId, ...data },
    update: data,
  })
}

/** Extend a session. Returns false when it was ended or never existed. */
export async function heartbeatUiSession(args: {
  prisma: AppPrismaClient
  sessionId: string
  userId: string
  currentPath?: string | null
  now?: Date
}): Promise<boolean> {
  const now = args.now ?? new Date()
  const result = await args.prisma.uiSession.updateMany({
    where: { id: args.sessionId, userId: args.userId, status: "ACTIVE" },
    data: {
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + UI_SESSION_TTL_MS),
      ...(args.currentPath !== undefined ? { currentPath: args.currentPath?.slice(0, 500) ?? null } : {}),
    },
  })
  return result.count > 0
}

export async function endUiSession(args: { prisma: AppPrismaClient; sessionId: string; userId: string }) {
  const now = new Date()
  await args.prisma.uiSession.updateMany({
    where: { id: args.sessionId, userId: args.userId, status: "ACTIVE" },
    data: { status: "ENDED", endedAt: now },
  })
  // Anything still queued for an ended session can never run.
  await args.prisma.uiCommand.updateMany({
    where: { sessionId: args.sessionId, status: { in: ["PENDING", "DELIVERED"] } },
    data: { status: "EXPIRED", completedAt: now, error: "The user ended agent control." },
  })
}

// ── Commands (agent side) ────────────────────────────────────────────────

export async function findActiveUiSession(args: {
  prisma: AppPrismaClient
  userId: string
  workspaceId: string
  now?: Date
}) {
  const now = args.now ?? new Date()
  return args.prisma.uiSession.findFirst({
    where: { userId: args.userId, workspaceId: args.workspaceId, status: "ACTIVE", expiresAt: { gt: now } },
    orderBy: { lastSeenAt: "desc" },
  })
}

export async function enqueueUiCommand(args: {
  prisma: AppPrismaClient
  userId: string
  workspaceId: string
  kind: UiCommandKind
  commandArgs?: Record<string, unknown>
  now?: Date
}) {
  const now = args.now ?? new Date()
  const session = await findActiveUiSession({ prisma: args.prisma, userId: args.userId, workspaceId: args.workspaceId, now })
  if (!session) {
    throw new UiControlError(
      "The user has not enabled agent control in a browser tab for this workspace. Ask them to open Compass and turn on 'Let agent drive'.",
      "NO_SESSION",
    )
  }
  return args.prisma.uiCommand.create({
    data: {
      sessionId: session.id,
      workspaceId: args.workspaceId,
      userId: args.userId,
      kind: args.kind,
      argsJson: JSON.stringify(args.commandArgs ?? {}),
      expiresAt: new Date(now.getTime() + UI_COMMAND_TTL_MS),
    },
  })
}

export type UiCommandOutcome = { status: "DONE" | "FAILED" | "EXPIRED"; result: unknown; error: string | null }

/** Poll until the command settles or `waitMs` elapses. */
export async function awaitUiCommand(args: {
  prisma: AppPrismaClient
  commandId: string
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<UiCommandOutcome> {
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + (args.waitMs ?? UI_COMMAND_WAIT_MS)
  for (;;) {
    const row = await args.prisma.uiCommand.findUnique({ where: { id: args.commandId } })
    if (!row) throw new UiControlError("Command not found.", "NOT_FOUND")
    if (row.status === "DONE" || row.status === "FAILED" || row.status === "EXPIRED") {
      return { status: row.status, result: row.resultJson ? safeParse(row.resultJson) : null, error: row.error }
    }
    if (Date.now() >= deadline) {
      await args.prisma.uiCommand.updateMany({
        where: { id: args.commandId, status: { in: ["PENDING", "DELIVERED"] } },
        data: { status: "EXPIRED", completedAt: new Date(), error: "Timed out waiting for the browser tab." },
      })
      throw new UiControlError("The user's browser tab did not respond in time (it may be backgrounded or closed).", "TIMEOUT")
    }
    await sleep(POLL_MS)
  }
}

/** Enqueue + wait, translating a non-DONE outcome into an error. */
export async function runUiCommand(args: {
  prisma: AppPrismaClient
  userId: string
  workspaceId: string
  kind: UiCommandKind
  commandArgs?: Record<string, unknown>
  waitMs?: number
}): Promise<unknown> {
  const command = await enqueueUiCommand(args)
  const outcome = await awaitUiCommand({ prisma: args.prisma, commandId: command.id, waitMs: args.waitMs })
  if (outcome.status !== "DONE") {
    throw new UiControlError(outcome.error ?? `Command ${outcome.status.toLowerCase()}.`, "REJECTED")
  }
  return outcome.result
}

// ── Commands (browser side) ──────────────────────────────────────────────

/**
 * Claim this session's pending commands. Each is moved PENDING→DELIVERED by a
 * fenced update; only commands this call actually moved are returned, so two
 * overlapping streams from one tab cannot both execute the same command.
 */
export async function claimPendingUiCommands(args: {
  prisma: AppPrismaClient
  sessionId: string
  userId: string
  now?: Date
}) {
  const now = args.now ?? new Date()
  const pending = await args.prisma.uiCommand.findMany({
    where: { sessionId: args.sessionId, userId: args.userId, status: "PENDING", expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    take: 10,
  })
  const claimed = []
  for (const command of pending) {
    const moved = await args.prisma.uiCommand.updateMany({
      where: { id: command.id, status: "PENDING" },
      data: { status: "DELIVERED", deliveredAt: now },
    })
    if (moved.count > 0) {
      claimed.push({ id: command.id, kind: command.kind as UiCommandKind, args: safeParse(command.argsJson) ?? {} })
    }
  }
  return claimed
}

/** First-write-wins completion of a delivered command. */
export async function completeUiCommand(args: {
  prisma: AppPrismaClient
  commandId: string
  userId: string
  ok: boolean
  result?: unknown
  error?: string | null
}): Promise<boolean> {
  const resultJson = args.result === undefined ? null : JSON.stringify(args.result)
  if (resultJson && resultJson.length > RESULT_MAX_CHARS) {
    throw new UiControlError("Result is too large.", "INVALID")
  }
  const moved = await args.prisma.uiCommand.updateMany({
    where: { id: args.commandId, userId: args.userId, status: "DELIVERED" },
    data: {
      status: args.ok ? "DONE" : "FAILED",
      completedAt: new Date(),
      resultJson,
      error: args.ok ? null : (args.error ?? "The browser reported a failure.").slice(0, 2_000),
    },
  })
  return moved.count > 0
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
