/**
 * Who may read an agent conversation, at the HTTP boundary: the real `messages` and `settings` route handlers and the
 * real access predicate against a real PostgreSQL schema; only auth() is mocked.
 *
 * Rick's call (TASK-195): a conversation the caller cannot read looks the same as one that does not exist. Every
 * unreadable case below must return a byte-identical 404 (status, body, content type, no-store) from both routes.
 */
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { injectUpdatedAtExtension } from "@/lib/prisma-updated-at"
import { resolveConversationAccess } from "@/lib/agent-conversation-access"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

process.env.DATABASE_URL ??= integrationDatabaseUrl
delete process.env.VERCEL

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null, userId: null as string | null }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))
vi.mock("@/auth", () => ({ auth: async () => (connection.userId ? { user: { id: connection.userId, email: "x@localhost.dev" } } : null) }))

const { GET: messagesRoute } = await import("@/app/api/agent/conversations/[conversationId]/messages/route")
const { GET: settingsRoute } = await import("@/app/api/agent/conversations/[conversationId]/settings/route")

const databaseUrl = integrationDatabaseUrl

type Snapshot = { status: number; body: string; contentType: string | null; cacheControl: string | null }

describe.skipIf(!databaseUrl)("agent conversation read access: member, non-member, other workspace, private, unknown", () => {
  const schema = `cva_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  const ids = {} as Record<string, string>

  const read = async (route: typeof messagesRoute, userId: string, conversationId: string, workspaceId: string): Promise<Snapshot> => {
    connection.userId = userId
    const res = await route(
      new Request(`http://x/api?workspaceId=${workspaceId}`) as never,
      { params: Promise.resolve({ conversationId }) } as never,
    )
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get("content-type"),
      cacheControl: res.headers.get("cache-control"),
    }
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Requires isolated local compass_e2e")
    pool = new Pool({ connectionString: databaseUrl, max: 6 })
    await pool.query(`CREATE SCHEMA "${schema}"`)
    url.searchParams.set("schema", schema)
    execFileSync("pnpm", ["exec", "prisma", "db", "push", "--url", url.toString()], { stdio: "pipe", timeout: 120_000 })
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient
    connection.prisma = prisma

    const org = await prisma.organization.create({ data: { slug: "cva-org", name: "Org" } })
    const mk = (n: string) => prisma.user.create({ data: { email: `${n}@x.dev`, name: n } })
    const [owner, teammate, participant, outsider, otherWsUser] = await Promise.all(
      ["owner", "teammate", "participant", "outsider", "otherws"].map(mk),
    )
    Object.assign(ids, { owner: owner.id, teammate: teammate.id, participant: participant.id, outsider: outsider.id, otherWsUser: otherWsUser.id })
    const ws = await prisma.workspace.create({ data: { organizationId: org.id, slug: "a", name: "A" } })
    const ws2 = await prisma.workspace.create({ data: { organizationId: org.id, slug: "b", name: "B" } })
    ids.ws = ws.id
    ids.ws2 = ws2.id
    for (const u of [owner, teammate, participant]) {
      await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: "MEMBER" } })
    }
    await prisma.workspaceMember.create({ data: { workspaceId: ws2.id, userId: otherWsUser.id, role: "MEMBER" } })
    await prisma.workspaceMember.create({ data: { workspaceId: ws2.id, userId: owner.id, role: "MEMBER" } })

    const chat = async (key: string, data: Record<string, unknown>) => {
      const row = await prisma.agentConversation.create({
        data: { workspaceId: ws.id, userId: owner.id, title: `SECRET TITLE ${key}`, ...data } as never,
      })
      await prisma.agentMessage.create({ data: { conversationId: row.id, role: "user", content: `SECRET BODY ${key}` } })
      ids[key] = row.id
    }
    await chat("private", { visibility: "PRIVATE", status: "OPEN" })
    await chat("shared", { visibility: "WORKSPACE", status: "OPEN" })
    await chat("archived", { visibility: "WORKSPACE", status: "ARCHIVED", archivedAt: new Date() })
    await chat("withParticipant", { visibility: "PRIVATE", status: "OPEN" })
    await prisma.agentConversationParticipant.create({
      data: { conversationId: ids.withParticipant, workspaceId: ws.id, userId: participant.id, addedByUserId: owner.id },
    })
    // A readable-by-owner chat that lives in the OTHER workspace.
    const elsewhere = await prisma.agentConversation.create({
      data: { workspaceId: ws2.id, userId: owner.id, title: "SECRET TITLE elsewhere", visibility: "WORKSPACE", status: "OPEN" } as never,
    })
    ids.elsewhere = elsewhere.id
  }, 180_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
      await pool.end()
    }
  })

  it("lets the owner, a workspace member (shared), a participant (private) and archived-but-readable through", async () => {
    for (const route of [messagesRoute, settingsRoute]) {
      expect((await read(route, ids.owner, ids.private, ids.ws)).status).toBe(200)
      expect((await read(route, ids.teammate, ids.shared, ids.ws)).status).toBe(200)
      expect((await read(route, ids.participant, ids.withParticipant, ids.ws)).status).toBe(200)
      expect((await read(route, ids.owner, ids.archived, ids.ws)).status).toBe(200)
      expect((await read(route, ids.teammate, ids.archived, ids.ws)).status).toBe(200)
    }
    for (const [user, conv, workspace] of [
      [ids.owner, ids.private, ids.ws],
      [ids.teammate, ids.shared, ids.ws],
      [ids.participant, ids.withParticipant, ids.ws],
      [ids.teammate, ids.archived, ids.ws],
    ] as const) {
      expect(await resolveConversationAccess(prisma, { conversationId: conv, workspaceId: workspace, userId: user })).not.toBeNull()
    }
  })

  it("answers every unreadable case with one identical, no-store 404 from both routes, and never names the conversation", async () => {
    const unreadable: Array<[string, string, string, string]> = [
      ["unknown id", ids.teammate, randomUUID(), ids.ws],
      ["malformed id", ids.teammate, "not-a-uuid", ids.ws],
      ["private chat of another member", ids.teammate, ids.private, ids.ws],
      ["non-member of the workspace", ids.outsider, ids.shared, ids.ws],
      ["member of another workspace only", ids.otherWsUser, ids.shared, ids.ws],
      ["right user, conversation lives in another workspace", ids.owner, ids.elsewhere, ids.ws],
      ["participant of a different private chat", ids.participant, ids.private, ids.ws],
    ]
    for (const route of [messagesRoute, settingsRoute]) {
      const snapshots = await Promise.all(unreadable.map(([, user, conv, ws]) => read(route, user, conv, ws)))
      for (const snap of snapshots) {
        expect(snap.status).toBe(404)
        expect(snap.body).not.toMatch(/SECRET/)
        expect(snap.cacheControl).toBe("no-store")
      }
      const [first, ...rest] = snapshots
      for (const [i, snap] of rest.entries()) {
        expect(snap, `${unreadable[i + 1]![0]} differs from ${unreadable[0]![0]}`).toEqual(first)
      }
    }
    for (const [, user, conv, workspace] of unreadable.filter(([label]) => label !== "malformed id")) {
      expect(await resolveConversationAccess(prisma, { conversationId: conv, workspaceId: workspace, userId: user })).toBeNull()
    }
  })

  it("serves the readable responses no-store too", async () => {
    expect((await read(messagesRoute, ids.owner, ids.private, ids.ws)).cacheControl).toBe("no-store")
    expect((await read(settingsRoute, ids.owner, ids.private, ids.ws)).cacheControl).toBe("no-store")
  })
})
