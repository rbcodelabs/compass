/**
 * Archive / restore of a shared conversation (lib/conversation-archive.ts, TASK-195 S2) against a real, disposable
 * PostgreSQL schema. The in-memory fakes cannot see two things this file exists for:
 *   - Prisma's updatedAt write extension stamps `now` on any update that omits it, so archive/restore must state
 *     `updatedAt` explicitly or the list reorders;
 *   - the authorization matrix and the "readable to exactly the same people" rule run against real membership rows.
 * No schema change. Set INTEGRATION_TEST_DATABASE_URL to an isolated localhost compass_e2e URL (no ?schema=) to enable.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))

import { listRestorableArchivedConversations, setConversationArchived } from "@/lib/conversation-archive"
import { getAgentConversationMessages } from "@/lib/agent-conversations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl
const SECRET = "confidential launch plan that must never reach an audit row"
const T0 = new Date("2026-11-10T09:00:00.000Z")

describe.skipIf(!databaseUrl)("conversation archive (real PostgreSQL)", () => {
  const schema = `conversation_archive_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let workspaceId: string
  let taskId: string
  const u = {} as Record<"starter" | "member" | "wsAdmin" | "orgAdmin" | "stranger", string>

  async function makeThread(updatedAt = T0) {
    const id = randomUUID()
    await prisma.agentConversation.create({
      data: { id, workspaceId, userId: u.starter, title: "Thread", visibility: "WORKSPACE", targetType: "TASK", targetId: taskId, createdAt: T0, updatedAt },
    })
    await prisma.agentMessage.createMany({
      data: [
        { id: randomUUID(), conversationId: id, role: "user", content: SECRET, authorUserId: u.starter, authorType: "HUMAN", messageKind: "MESSAGE", createdAt: new Date(T0.getTime() + 1000) },
        { id: randomUUID(), conversationId: id, role: "user", content: "a reply", authorUserId: u.member, authorType: "HUMAN", messageKind: "MESSAGE", createdAt: new Date(T0.getTime() + 2000) },
      ],
    })
    return id
  }
  const set = (conversationId: string, userId: string, archived: boolean) => setConversationArchived({ conversationId, workspaceId, userId, archived })
  const row = (id: string) => prisma.agentConversation.findUniqueOrThrow({ where: { id } })
  const audits = (conversationIdInSummary: string) =>
    prisma.agentAuditLog.findMany({ where: { workspaceId, argsSummary: { contains: conversationIdInSummary } }, orderBy: { createdAt: "asc" } })

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Requires an isolated local compass_e2e URL without a schema override")
    }
    pool = new Pool({ connectionString: databaseUrl, max: 10 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 180_000 })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient
    connection.prisma = prisma
    const org = await prisma.organization.create({ data: { slug: `ca-${randomUUID().slice(0, 8)}`, name: "Conversation Archive" } })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org.id, slug: "ca", name: "CA" } })).id
    for (const key of ["starter", "member", "wsAdmin", "orgAdmin", "stranger"] as const) {
      u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    }
    for (const key of ["starter", "member", "wsAdmin", "orgAdmin"] as const) {
      await prisma.workspaceMember.create({ data: { workspaceId, userId: u[key], role: key === "wsAdmin" ? "ADMIN" : "MEMBER" } })
    }
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: u.orgAdmin, role: "OWNER" } })
    taskId = (await prisma.task.create({ data: { workspaceId, title: "Anchor task" } })).id
  }, 240_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  it("archives without reordering the list, keeps every message, and leaves no agent run", async () => {
    const id = await makeThread()
    const result = await set(id, u.starter, true)
    expect(result).toEqual({ ok: true, archived: true, changed: true })
    const after = await row(id)
    expect(after.archivedAt).toBeInstanceOf(Date)
    // The updatedAt write extension would have stamped `now`; the service states the old value.
    expect(after.updatedAt.toISOString()).toBe(T0.toISOString())
    expect(await prisma.agentMessage.count({ where: { conversationId: id } })).toBe(2)
    expect(await prisma.agentRun.count({ where: { conversationId: id } })).toBe(0)
  })

  it("restores with the same position and the messages intact", async () => {
    const id = await makeThread()
    await set(id, u.starter, true)
    expect(await set(id, u.starter, false)).toEqual({ ok: true, archived: false, changed: true })
    const after = await row(id)
    expect(after.archivedAt).toBeNull()
    expect(after.updatedAt.toISOString()).toBe(T0.toISOString())
    const messages = await getAgentConversationMessages(id, workspaceId, u.member)
    expect(messages?.map((m) => m.content)).toEqual([SECRET, "a reply"])
  })

  it("is idempotent and writes one audit row per real change", async () => {
    const id = await makeThread()
    await set(id, u.starter, true)
    const first = (await row(id)).archivedAt
    expect(await set(id, u.starter, true)).toEqual({ ok: true, archived: true, changed: false })
    expect((await row(id)).archivedAt?.toISOString()).toBe(first?.toISOString())
    expect(await set(id, u.starter, false)).toMatchObject({ changed: true })
    expect(await set(id, u.starter, false)).toMatchObject({ changed: false })
    const rows = await audits(id)
    expect(rows.map((r) => r.toolName)).toEqual(["conversation.archive", "conversation.restore"])
    for (const r of rows) {
      expect(r.conversationId).toBeNull()
      expect(r.argsSummary).not.toContain(SECRET)
      expect(JSON.parse(r.argsSummary!)).toMatchObject({ conversationId: id, targetType: "TASK", messageCount: 2, role: "STARTER" })
    }
  })

  it("authorization matrix: starter, workspace admin and org admin may; another member 403; a non-member 404", async () => {
    const a = await makeThread()
    expect(await set(a, u.member, true)).toEqual({ ok: false, status: 403 })
    expect(await set(a, u.stranger, true)).toEqual({ ok: false, status: 404 })
    expect((await row(a)).archivedAt).toBeNull()
    expect(await set(a, u.wsAdmin, true)).toMatchObject({ ok: true, changed: true })
    const b = await makeThread()
    expect(await set(b, u.orgAdmin, true)).toMatchObject({ ok: true, changed: true })
    expect((await audits(b))[0]!.argsSummary).toContain('"role":"ADMIN"')
  })

  it("an archived thread stays readable to its members and invisible to a non-member", async () => {
    const id = await makeThread()
    await set(id, u.starter, true)
    expect((await getAgentConversationMessages(id, workspaceId, u.member))?.length).toBe(2)
    expect(await getAgentConversationMessages(id, workspaceId, u.stranger)).toBeNull()
  })

  it("lists archived rows only for people who may restore them", async () => {
    const mine = await makeThread()
    await set(mine, u.starter, true)
    const ids = (userId: string) => listRestorableArchivedConversations({ workspaceId, userId, targetType: "TASK", targetId: taskId, linkedIds: [] }).then((rows) => rows.map((r) => r.id))
    expect(await ids(u.starter)).toContain(mine)
    expect(await ids(u.wsAdmin)).toContain(mine)
    expect(await ids(u.orgAdmin)).toContain(mine)
    expect(await ids(u.member)).not.toContain(mine)
    expect(await ids(u.stranger)).not.toContain(mine)
  })
})
