/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory prisma fake */
import { describe, expect, it } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import {
  awaitUiCommand,
  claimPendingUiCommands,
  completeUiCommand,
  endUiSession,
  enqueueUiCommand,
  resolveNavigationPath,
  startUiSession,
  UiControlError,
} from "@/lib/ui-control"

const BASE = "/acme/growth"

describe("resolveNavigationPath", () => {
  it("accepts workspace paths with query and hash", () => {
    expect(resolveNavigationPath("/acme/growth/roadmap?x=1#top", BASE)).toBe("/acme/growth/roadmap?x=1#top")
    expect(resolveNavigationPath("/acme/growth", BASE)).toBe("/acme/growth")
  })

  it.each([
    "https://evil.example/acme/growth",
    "//evil.example/acme/growth",
    "acme/growth/roadmap",
    "/acme/growth/../other/roadmap",
    "/acme/growthy/roadmap",
    "/other/ws",
    "/acme/growth\\..\\x",
    "/acme/growth/\u0000",
    "/api/admin/migrate",
  ])("refuses %s", (path) => {
    expect(() => resolveNavigationPath(path, BASE)).toThrow(UiControlError)
  })
})

// Minimal in-memory stand-in for the two delegates the module uses.
function fakePrisma() {
  type Row = Record<string, any>
  const sessions: Row[] = []
  const commands: Row[] = []
  let n = 0
  const match = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("in" in v) return v.in.includes(row[k])
        if ("gt" in v) return row[k] > v.gt
        return true
      }
      return row[k] === v
    })
  const delegate = (rows: Row[]) => ({
    findFirst: async ({ where }: any) => rows.find((r) => match(r, where)) ?? null,
    findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: any) => rows.filter((r) => match(r, where)),
    create: async ({ data }: any) => {
      const row = { id: `id-${++n}`, status: "PENDING", ...data }
      rows.push(row)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      const hit = rows.filter((r) => match(r, where))
      hit.forEach((r) => Object.assign(r, data))
      return { count: hit.length }
    },
    upsert: async ({ where, create, update }: any) => {
      const key = where.userId_workspaceId_tabId
      const found = rows.find((r) => r.userId === key.userId && r.workspaceId === key.workspaceId && r.tabId === key.tabId)
      if (found) return Object.assign(found, update)
      const row = { id: `id-${++n}`, ...create }
      rows.push(row)
      return row
    },
  })
  const prisma = { uiSession: delegate(sessions), uiCommand: delegate(commands) } as unknown as AppPrismaClient
  return { prisma, sessions, commands }
}

const ids = { userId: "u1", workspaceId: "w1" }

describe("command lifecycle", () => {
  it("refuses to enqueue without an opted-in session", async () => {
    const { prisma } = fakePrisma()
    await expect(enqueueUiCommand({ prisma, ...ids, kind: "get_state" })).rejects.toMatchObject({ code: "NO_SESSION" })
  })

  it("does not reach another user's session", async () => {
    const { prisma } = fakePrisma()
    await startUiSession({ prisma, userId: "someone-else", workspaceId: "w1", tabId: "tab-aaaaaaaa" })
    await expect(enqueueUiCommand({ prisma, ...ids, kind: "get_state" })).rejects.toMatchObject({ code: "NO_SESSION" })
  })

  it("does not reach an expired session", async () => {
    const { prisma } = fakePrisma()
    await startUiSession({ prisma, ...ids, tabId: "tab-aaaaaaaa", now: new Date(Date.now() - 10 * 60_000) })
    await expect(enqueueUiCommand({ prisma, ...ids, kind: "get_state" })).rejects.toMatchObject({ code: "NO_SESSION" })
  })

  it("delivers once, completes once, and the agent sees the result", async () => {
    const { prisma } = fakePrisma()
    const session = await startUiSession({ prisma, ...ids, tabId: "tab-aaaaaaaa" })
    const command = await enqueueUiCommand({ prisma, ...ids, kind: "navigate", commandArgs: { path: "/acme/growth/roadmap" } })

    const first = await claimPendingUiCommands({ prisma, sessionId: session.id, userId: ids.userId })
    const second = await claimPendingUiCommands({ prisma, sessionId: session.id, userId: ids.userId })
    expect(first.map((c) => c.id)).toEqual([command.id])
    expect(first[0].args).toEqual({ path: "/acme/growth/roadmap" })
    expect(second).toEqual([])

    expect(await completeUiCommand({ prisma, commandId: command.id, userId: ids.userId, ok: true, result: { path: "/x" } })).toBe(true)
    expect(await completeUiCommand({ prisma, commandId: command.id, userId: ids.userId, ok: false, error: "late" })).toBe(false)

    const outcome = await awaitUiCommand({ prisma, commandId: command.id, waitMs: 50, sleep: async () => {} })
    expect(outcome).toEqual({ status: "DONE", result: { path: "/x" }, error: null })
  })

  it("rejects a result posted by a different user", async () => {
    const { prisma } = fakePrisma()
    const session = await startUiSession({ prisma, ...ids, tabId: "tab-aaaaaaaa" })
    const command = await enqueueUiCommand({ prisma, ...ids, kind: "get_state" })
    await claimPendingUiCommands({ prisma, sessionId: session.id, userId: ids.userId })
    expect(await completeUiCommand({ prisma, commandId: command.id, userId: "intruder", ok: true, result: {} })).toBe(false)
  })

  it("times out and expires an unanswered command", async () => {
    const { prisma, commands } = fakePrisma()
    await startUiSession({ prisma, ...ids, tabId: "tab-aaaaaaaa" })
    const command = await enqueueUiCommand({ prisma, ...ids, kind: "screenshot" })
    await expect(awaitUiCommand({ prisma, commandId: command.id, waitMs: 0, sleep: async () => {} })).rejects.toMatchObject({ code: "TIMEOUT" })
    expect(commands[0].status).toBe("EXPIRED")
  })

  it("stopping the session expires what was queued", async () => {
    const { prisma, commands } = fakePrisma()
    const session = await startUiSession({ prisma, ...ids, tabId: "tab-aaaaaaaa" })
    await enqueueUiCommand({ prisma, ...ids, kind: "get_state" })
    await endUiSession({ prisma, sessionId: session.id, userId: ids.userId })
    expect(commands[0].status).toBe("EXPIRED")
    await expect(enqueueUiCommand({ prisma, ...ids, kind: "get_state" })).rejects.toMatchObject({ code: "NO_SESSION" })
  })
})
