/**
 * Comment-origin deep link (lib/conversation-locate.ts, TASK-195 S3) against a real, disposable PostgreSQL schema:
 * the read-access matrix, repair of a missing mirror, and the hazard this repo's updatedAt write extension creates
 * (a locate must never reorder conversations). No schema change.
 *
 * Set INTEGRATION_TEST_DATABASE_URL to an isolated localhost compass_e2e URL (no ?schema=) to enable; skipped otherwise.
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

import { locateConversationMessage } from "@/lib/conversation-locate"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl
const BASE = new Date("2026-11-16T12:00:00.000Z").getTime()
const at = (minutes: number) => new Date(BASE + minutes * 60_000)

describe.skipIf(!databaseUrl)("comment-origin deep link locate (real PostgreSQL)", () => {
  const schema = `conversation_locate_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let workspaceId: string
  let otherWorkspaceId: string
  let opportunityId: string
  const u = {} as Record<"owner" | "member" | "participant" | "outsider", string>

  const locate = (messageId: string, userId = u.member, ws = workspaceId) => locateConversationMessage(prisma, { workspaceId: ws, userId, messageId })
  const conversation = (id: string) => prisma.agentConversation.findUnique({ where: { id } })
  const messageIds = async (conversationId: string) => (await prisma.agentMessage.findMany({ where: { conversationId }, select: { id: true } })).map((m) => m.id).sort()
  const conversationCount = () => prisma.agentConversation.count()

  /** A comment thread with NO mirror (what a swallowed dual-write leaves behind). */
  async function makeCommentThread(options: { replies?: number; targetType?: string; targetId?: string; ws?: string } = {}) {
    const ws = options.ws ?? workspaceId
    const rootId = randomUUID()
    const common = { workspaceId: ws, targetType: options.targetType ?? "OPPORTUNITY", targetId: options.targetId ?? opportunityId, authorType: "HUMAN", source: "UI", status: "OPEN" }
    await prisma.comment.create({ data: { ...common, id: rootId, parentId: null, body: "Root text", authorId: u.owner, authorName: "Owner", createdAt: at(0), updatedAt: at(0) } })
    const replyIds = Array.from({ length: options.replies ?? 1 }, () => randomUUID())
    await prisma.comment.createMany({
      data: replyIds.map((id, index) => ({ ...common, id, parentId: rootId, body: `Reply ${index}`, authorId: u.member, authorName: "Member", createdAt: at(index + 1), updatedAt: at(index + 1) })),
    })
    return { rootId, replyIds }
  }

  /** A panel-style conversation with random message ids (no comment behind it). */
  async function makePanelConversation(options: { visibility?: string; userId?: string; updatedAt: Date; archived?: boolean; ws?: string }) {
    const id = randomUUID()
    await prisma.agentConversation.create({
      data: {
        id, workspaceId: options.ws ?? workspaceId, userId: options.userId ?? u.owner, title: `Panel ${id.slice(0, 4)}`, summary: "panel summary",
        targetType: "OPPORTUNITY", targetId: opportunityId, visibility: options.visibility ?? "WORKSPACE", status: "OPEN", agentMode: "MENTION_ONLY",
        archivedAt: options.archived ? at(300) : null, createdAt: at(0), updatedAt: options.updatedAt,
      },
    })
    const messageId = randomUUID()
    await prisma.agentMessage.create({ data: { id: messageId, conversationId: id, role: "user", content: "panel hello", authorUserId: options.userId ?? u.owner, authorName: "Owner", authorType: "HUMAN", createdAt: at(1) } })
    return { id, messageId }
  }

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
    const org = await prisma.organization.create({ data: { slug: `cl-${randomUUID().slice(0, 8)}`, name: "Conversation Locate" } })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org.id, slug: "cl", name: "CL" } })).id
    otherWorkspaceId = (await prisma.workspace.create({ data: { organizationId: org.id, slug: "cl-other", name: "CL other" } })).id
    for (const key of ["owner", "member", "participant", "outsider"] as const) u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    for (const key of ["owner", "member", "participant"] as const) await prisma.workspaceMember.create({ data: { workspaceId, userId: u[key], role: "MEMBER" } })
    // The outsider belongs to a different workspace only.
    await prisma.workspaceMember.create({ data: { workspaceId: otherWorkspaceId, userId: u.outsider, role: "MEMBER" } })
    opportunityId = (await prisma.opportunity.create({ data: { workspaceId, title: "Locate target" } })).id
  }, 240_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  it("repairs a missing mirror: the reply's id locates the whole thread, with the comment ids and one messageKind", async () => {
    const thread = await makeCommentThread({ replies: 2 })
    expect(await conversation(thread.rootId)).toBeNull()
    const located = await locate(thread.replyIds[1]!)
    expect(located).toMatchObject({ conversationId: thread.rootId, messageId: thread.replyIds[1], isRoot: false, targetType: "OPPORTUNITY", targetId: opportunityId, status: "OPEN", archived: false })
    expect(await messageIds(thread.rootId)).toEqual([thread.rootId, ...thread.replyIds].sort())
    const messages = await prisma.agentMessage.findMany({ where: { conversationId: thread.rootId } })
    expect(messages.every((m) => m.messageKind === "COMMENT")).toBe(true)
    // The root id locates the same conversation and says it is the root.
    expect(await locate(thread.rootId)).toMatchObject({ conversationId: thread.rootId, isRoot: true })
  })

  it("a second locate writes nothing (no new rows, updatedAt untouched)", async () => {
    const thread = await makeCommentThread({ replies: 1 })
    await locate(thread.replyIds[0]!)
    const before = await conversation(thread.rootId)
    const messagesBefore = await prisma.agentMessage.findMany({ where: { conversationId: thread.rootId }, orderBy: { id: "asc" } })
    await locate(thread.replyIds[0]!)
    await locate(thread.rootId)
    expect((await conversation(thread.rootId))!.updatedAt).toEqual(before!.updatedAt)
    expect(await prisma.agentMessage.findMany({ where: { conversationId: thread.rootId }, orderBy: { id: "asc" } })).toEqual(messagesBefore)
  })

  it("repair and locate never reorder or touch an unrelated conversation (the updatedAt write extension hazard)", async () => {
    const older = await makePanelConversation({ updatedAt: at(100) })
    const newer = await makePanelConversation({ updatedAt: at(200) })
    const order = async () => (await prisma.agentConversation.findMany({ where: { id: { in: [older.id, newer.id] } }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], select: { id: true, updatedAt: true } }))
    const before = await order()

    const thread = await makeCommentThread({ replies: 1 })
    await locate(thread.replyIds[0]!) // repairs a missing mirror
    await locate(older.messageId) // a plain hit
    await locate(newer.id) // an id that is neither message nor comment

    expect(await order()).toEqual(before)
    // The repaired conversation carries the real thread time, not "now".
    expect((await conversation(thread.rootId))!.updatedAt).toEqual(at(1))
  })

  it("repairing one missing message in an existing conversation keeps the newer updatedAt and summary a panel message set", async () => {
    const thread = await makeCommentThread({ replies: 1 })
    await locate(thread.rootId)
    // A panel message / agent run made the conversation newer, then the reply's mirror row went missing.
    const newer = at(500)
    await prisma.agentConversation.update({ where: { id: thread.rootId }, data: { updatedAt: newer, summary: "Newer agent answer" } })
    await prisma.agentMessage.delete({ where: { id: thread.replyIds[0]! } })
    const located = await locate(thread.replyIds[0]!)
    expect(located?.conversationId).toBe(thread.rootId)
    expect(await messageIds(thread.rootId)).toEqual([thread.rootId, ...thread.replyIds].sort())
    expect(await conversation(thread.rootId)).toMatchObject({ updatedAt: newer, summary: "Newer agent answer" })
  })

  it("a conversation that appears between the check and the repair keeps its newer updatedAt, status and summary (create-only repair)", async () => {
    const thread = await makeCommentThread({ replies: 1 })
    const newer = at(700)
    // The other writer wins the race: its conversation exists before the repair's header write.
    await prisma.agentConversation.create({
      data: { id: thread.rootId, workspaceId, userId: u.owner, title: "winner", summary: "Winner summary", targetType: "OPPORTUNITY", targetId: opportunityId, visibility: "WORKSPACE", status: "RESOLVED", agentMode: "MENTION_ONLY", createdAt: at(0), updatedAt: newer },
    })
    const { ensureConversationForComment } = await import("@/lib/conversation-mirror")
    await ensureConversationForComment(prisma, thread.replyIds[0]!, { scope: "create-only" })
    expect(await conversation(thread.rootId)).toMatchObject({ title: "winner", summary: "Winner summary", status: "RESOLVED", updatedAt: newer })
    expect(await messageIds(thread.rootId)).toEqual([thread.rootId, ...thread.replyIds].sort())
  })

  describe("who may locate what (404 everywhere else: nothing is created, nothing is revealed)", () => {
    it("a workspace member locates a shared thread by message id and by comment id", async () => {
      const panel = await makePanelConversation({ updatedAt: at(10) })
      expect(await locate(panel.messageId, u.member)).toMatchObject({ conversationId: panel.id })
      const thread = await makeCommentThread()
      expect(await locate(thread.rootId, u.participant)).toMatchObject({ conversationId: thread.rootId })
    })

    it("a user outside the workspace gets null for message ids and comment ids, and no mirror is created for them", async () => {
      const panel = await makePanelConversation({ updatedAt: at(10) })
      const thread = await makeCommentThread()
      const before = await conversationCount()
      expect(await locate(panel.messageId, u.outsider)).toBeNull()
      expect(await locate(thread.rootId, u.outsider)).toBeNull()
      expect(await locate(thread.replyIds[0]!, u.outsider)).toBeNull()
      expect(await conversationCount()).toBe(before)
      expect(await conversation(thread.rootId)).toBeNull()
    })

    it("a member asking about another workspace's ids gets null (the workspace must match)", async () => {
      const foreign = await makePanelConversation({ updatedAt: at(10), ws: otherWorkspaceId, userId: u.outsider })
      expect(await locate(foreign.messageId, u.member, workspaceId)).toBeNull()
      expect(await locate(foreign.messageId, u.member, otherWorkspaceId)).toBeNull() // and not a member of it either
      expect(await locate(foreign.messageId, u.outsider, otherWorkspaceId)).toMatchObject({ conversationId: foreign.id })
    })

    it("a private chat is invisible to other members, visible to its owner and to an invited participant", async () => {
      const chat = await makePanelConversation({ visibility: "PRIVATE", updatedAt: at(10) })
      expect(await locate(chat.messageId, u.member)).toBeNull()
      expect(await locate(chat.messageId, u.owner)).toMatchObject({ conversationId: chat.id })
      await prisma.agentConversationParticipant.create({ data: { conversationId: chat.id, workspaceId, userId: u.participant, addedByUserId: u.owner } })
      expect(await locate(chat.messageId, u.participant)).toMatchObject({ conversationId: chat.id })
      await prisma.agentConversationParticipant.updateMany({ where: { conversationId: chat.id, userId: u.participant }, data: { removedAt: at(20) } })
      expect(await locate(chat.messageId, u.participant)).toBeNull()
    })

    it("an archived thread is still located for everyone who could read it, and flagged archived", async () => {
      const panel = await makePanelConversation({ updatedAt: at(10), archived: true })
      expect(await locate(panel.messageId, u.member)).toMatchObject({ conversationId: panel.id, archived: true })
      expect(await locate(panel.messageId, u.outsider)).toBeNull()
    })

    it("a comment thread whose conversation is a private chat is not repaired or revealed to others", async () => {
      // The conversation row already exists under the root comment's id but is private: the member may not read it.
      const thread = await makeCommentThread({ replies: 1 })
      await prisma.agentConversation.create({
        data: { id: thread.rootId, workspaceId, userId: u.owner, title: "private", summary: "private", targetType: "OPPORTUNITY", targetId: opportunityId, visibility: "PRIVATE", status: "OPEN", agentMode: "AUTO", createdAt: at(0), updatedAt: at(5) },
      })
      expect(await locate(thread.replyIds[0]!, u.member)).toBeNull()
      expect(await messageIds(thread.rootId)).toEqual([])
      expect((await conversation(thread.rootId))!.updatedAt).toEqual(at(5))
    })

    it("an unknown or deleted id is null", async () => {
      expect(await locate(randomUUID())).toBeNull()
      const thread = await makeCommentThread()
      await locate(thread.rootId)
      await prisma.agentMessage.deleteMany({ where: { conversationId: thread.rootId } })
      await prisma.agentConversation.delete({ where: { id: thread.rootId } })
      await prisma.comment.deleteMany({ where: { parentId: thread.rootId } })
      await prisma.comment.delete({ where: { id: thread.rootId } })
      expect(await locate(thread.rootId)).toBeNull()
    })
  })

  it("a document comment is located like any other (the client leaves it to the Docs sidebar)", async () => {
    const docId = randomUUID()
    const thread = await makeCommentThread({ targetType: "DOC", targetId: docId })
    expect(await locate(thread.rootId)).toMatchObject({ conversationId: thread.rootId, targetType: "DOC", targetId: docId })
  })
})
