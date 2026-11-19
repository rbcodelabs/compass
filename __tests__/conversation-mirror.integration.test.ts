/**
 * The comment-to-conversation mirror (lib/conversation-mirror.ts, TASK-195 S0) against a real, disposable PostgreSQL schema:
 * creation and idempotent repair, reply and thread deletes (purge vs archive), paging across the 500-row batch boundary, the
 * RepeatableRead conflict with a concurrent panel post, the create-vs-delete race, and tolerance of optional tables that are
 * not migrated. No schema change.
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

import { ARCHIVED_MIRROR_TITLE, ensureConversationForComment, mirrorCommentAfterCommit, removeCommentMirror } from "@/lib/conversation-mirror"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl
const SECRET_ROOT = "Root text that must not survive deletion"
const SECRET_REPLY = "Reply text that must not survive deletion"
const BASE = new Date("2026-11-16T12:00:00.000Z").getTime()
const at = (minutes: number) => new Date(BASE + minutes * 60_000)

describe.skipIf(!databaseUrl)("conversation mirror (real PostgreSQL)", () => {
  const schema = `conversation_mirror_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let workspaceId: string
  let opportunityId: string
  const u = {} as Record<"owner" | "replier" | "stranger", string>

  type Thread = { rootId: string; replyIds: string[] }

  async function makeThread(options: { replies?: number; rootBody?: string; replyBody?: string } = {}): Promise<Thread> {
    const rootId = randomUUID()
    const common = { workspaceId, targetType: "OPPORTUNITY", targetId: opportunityId, authorType: "HUMAN", source: "UI", status: "OPEN" }
    await prisma.comment.create({ data: { ...common, id: rootId, parentId: null, body: options.rootBody ?? SECRET_ROOT, authorId: u.owner, authorName: "Owner", createdAt: at(0), updatedAt: at(0) } })
    const replyIds = Array.from({ length: options.replies ?? 1 }, () => randomUUID())
    await prisma.comment.createMany({
      data: replyIds.map((id, index) => ({
        ...common, id, parentId: rootId, body: options.replyBody ?? `${SECRET_REPLY} ${index}`, authorId: u.replier, authorName: "Replier", createdAt: at(index + 1), updatedAt: at(index + 1),
      })),
    })
    return { rootId, replyIds }
  }
  const conversation = (id: string) => prisma.agentConversation.findUnique({ where: { id } })
  const messageIds = async (conversationId: string) => (await prisma.agentMessage.findMany({ where: { conversationId }, select: { id: true } })).map((m) => m.id).sort()
  const entityLinkCount = async (id: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".entity_links WHERE from_id = $1 OR to_id = $1`, [id])).rows[0].n)
  const remove = (thread: Thread, extra: { ids?: string[]; threadDeleted?: boolean } = {}) =>
    removeCommentMirror(prisma, { conversationId: thread.rootId, commentIds: extra.ids ?? [thread.rootId, ...thread.replyIds], threadDeleted: extra.threadDeleted ?? true })
  /** Deletes the comments the way a legacy delete would, then removes the mirror. */
  const deleteComments = async (ids: string[]) => {
    // Replies first: relationMode="prisma" emulates Restrict on the self-relation.
    await prisma.comment.deleteMany({ where: { id: { in: ids }, parentId: { not: null } } })
    await prisma.comment.deleteMany({ where: { id: { in: ids } } })
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
    const org = await prisma.organization.create({ data: { slug: `cm-${randomUUID().slice(0, 8)}`, name: "Conversation Mirror" } })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org.id, slug: "cm", name: "CM" } })).id
    for (const key of ["owner", "replier", "stranger"] as const) u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    for (const key of ["owner", "replier"] as const) await prisma.workspaceMember.create({ data: { workspaceId, userId: u[key], role: "MEMBER" } })
    opportunityId = (await prisma.opportunity.create({ data: { workspaceId, title: "Mirror target" } })).id
  }, 240_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  it("mirrors a comment with replies, with the comment ids, one unified messageKind, and is idempotent", async () => {
    const thread = await makeThread({ replies: 2 })
    const first = await ensureConversationForComment(prisma, thread.replyIds[1]!)
    expect(first).toEqual({ conversationId: thread.rootId, messageId: thread.replyIds[1] })
    const afterFirst = await prisma.agentMessage.findMany({ where: { conversationId: thread.rootId }, orderBy: { createdAt: "asc" } })
    expect(afterFirst.map((m) => m.id)).toEqual([thread.rootId, ...thread.replyIds])
    expect(afterFirst.every((m) => m.messageKind === "COMMENT")).toBe(true)
    expect(await conversation(thread.rootId)).toMatchObject({ id: thread.rootId, userId: u.owner, visibility: "WORKSPACE", targetType: "OPPORTUNITY", targetId: opportunityId, agentMode: "MENTION_ONLY" })

    const second = await ensureConversationForComment(prisma, thread.rootId)
    expect(second?.conversationId).toBe(first?.conversationId)
    expect(await messageIds(thread.rootId)).toEqual([thread.rootId, ...thread.replyIds].sort())
    expect(await prisma.agentConversation.count({ where: { id: thread.rootId } })).toBe(1)
  })

  it("resolving and reopening a thread never marks the root message edited, but a real body edit does", async () => {
    const thread = await makeThread({ replies: 1 })
    await ensureConversationForComment(prisma, thread.rootId)
    const editedAt = async () => (await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.rootId } })).editedAt
    // What setCommentStatus does: the status changes and Comment.updatedAt moves, the text does not.
    await prisma.comment.update({ where: { id: thread.rootId }, data: { status: "RESOLVED", updatedAt: at(40) } })
    await ensureConversationForComment(prisma, thread.rootId)
    expect(await editedAt()).toBeNull()
    await prisma.comment.update({ where: { id: thread.rootId }, data: { status: "OPEN", updatedAt: at(41) } })
    await ensureConversationForComment(prisma, thread.rootId)
    expect(await editedAt()).toBeNull()
    // A message that is re-created from a resolved root is unedited as well.
    await prisma.comment.update({ where: { id: thread.rootId }, data: { status: "RESOLVED", updatedAt: at(42) } })
    await prisma.agentMessage.delete({ where: { id: thread.rootId } })
    await ensureConversationForComment(prisma, thread.rootId)
    expect(await editedAt()).toBeNull()
    // A real change of the text is still an edit, stamped with the comment's update time.
    await prisma.comment.update({ where: { id: thread.rootId }, data: { body: "Reworded root", updatedAt: at(50) } })
    await ensureConversationForComment(prisma, thread.rootId)
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.rootId } })).content).toBe("Reworded root")
    expect((await editedAt())?.getTime()).toBe(at(50).getTime())
    // The edit survives a later resolve.
    await prisma.comment.update({ where: { id: thread.rootId }, data: { status: "OPEN", updatedAt: at(60) } })
    await ensureConversationForComment(prisma, thread.rootId)
    expect((await editedAt())?.getTime()).toBe(at(50).getTime())
  })

  it("the create path writes only the new comment and never lowers updatedAt or overwrites a newer summary", async () => {
    const thread = await makeThread({ replies: 1 })
    await prisma.comment.delete({ where: { id: thread.replyIds[0]! } })
    await ensureConversationForComment(prisma, thread.rootId)
    const newer = at(500)
    await prisma.agentConversation.update({ where: { id: thread.rootId }, data: { updatedAt: newer, summary: "Newer agent answer" } })
    const replyId = randomUUID()
    await prisma.comment.create({ data: { id: replyId, workspaceId, targetType: "OPPORTUNITY", targetId: opportunityId, parentId: thread.rootId, body: "late reply", authorId: u.replier, authorName: "Replier", authorType: "HUMAN", source: "UI", createdAt: at(10), updatedAt: at(10) } })
    await mirrorCommentAfterCommit(replyId)
    expect(await messageIds(thread.rootId)).toEqual([thread.rootId, replyId].sort())
    expect(await conversation(thread.rootId)).toMatchObject({ updatedAt: newer, summary: "Newer agent answer" })
  })

  it("a reply delete removes its message and recomputes summary and updatedAt: the deleted text appears nowhere on the conversation row", async () => {
    const thread = await makeThread({ replies: 1 })
    await ensureConversationForComment(prisma, thread.rootId)
    expect((await conversation(thread.rootId))?.summary).toContain("Reply text")
    await deleteComments(thread.replyIds)
    await remove(thread, { ids: thread.replyIds, threadDeleted: false })
    expect(await messageIds(thread.rootId)).toEqual([thread.rootId])
    const row = await conversation(thread.rootId)
    expect(row?.summary).toContain("Root text")
    expect(row?.updatedAt.getTime()).toBe(at(0).getTime())
    expect(JSON.stringify(row)).not.toContain("Reply text")
  })

  it("a root delete of a pure-mirror thread purges the conversation and its dependent rows", async () => {
    const thread = await makeThread({ replies: 2 })
    await ensureConversationForComment(prisma, thread.rootId)
    await prisma.agentConversationParticipant.create({ data: { conversationId: thread.rootId, workspaceId, userId: u.replier, addedByUserId: u.owner } })
    expect(await entityLinkCount(thread.rootId)).toBeGreaterThan(0)
    await deleteComments([thread.rootId, ...thread.replyIds])
    await remove(thread)
    expect(await conversation(thread.rootId)).toBeNull()
    expect(await messageIds(thread.rootId)).toEqual([])
    expect(await prisma.agentConversationParticipant.count({ where: { conversationId: thread.rootId } })).toBe(0)
    expect(await entityLinkCount(thread.rootId)).toBe(0)
  })

  const nonMirrorContent: Array<[string, (thread: Thread) => Promise<unknown>, string[]]> = [
    ["a panel-created message", (t) => prisma.agentMessage.create({ data: { conversationId: t.rootId, role: "user", content: "panel message", authorUserId: u.owner, createdAt: at(600) } }), ["panel message"]],
    ["an agent run", (t) => prisma.agentRun.create({ data: { conversationId: t.rootId, workspaceId, userId: u.owner, workerTokenHash: randomUUID().replaceAll("-", ""), deadlineAt: at(900) } }), []],
    ["an inbox item", (t) => prisma.agentInboxItem.create({ data: { workspaceId, conversationId: t.rootId, kind: "QUESTION", question: "Which one?" } }), []],
    ["a participant who is not a comment author", (t) => prisma.agentConversationParticipant.create({ data: { conversationId: t.rootId, workspaceId, userId: u.stranger, addedByUserId: u.owner } }), []],
  ]
  it.each(nonMirrorContent)("a root delete with %s ARCHIVES: neutral title, no summary, other content intact", async (_label, add, panelText) => {
    const thread = await makeThread({ replies: 1 })
    await ensureConversationForComment(prisma, thread.rootId)
    await add(thread)
    await deleteComments([thread.rootId, ...thread.replyIds])
    await remove(thread)
    const row = await conversation(thread.rootId)
    expect(row).not.toBeNull()
    expect(row?.archivedAt).toBeInstanceOf(Date)
    expect(row?.title).toBe(ARCHIVED_MIRROR_TITLE)
    expect(row?.summary).toBeNull()
    expect(JSON.stringify(row)).not.toContain("Root text")
    expect(JSON.stringify(row)).not.toContain("Reply text")
    const remaining = await prisma.agentMessage.findMany({ where: { conversationId: thread.rootId } })
    expect(remaining.map((m) => m.content)).toEqual(panelText)
  })

  it("deletes a 1,200-reply thread across the 500-row batch boundary", async () => {
    const thread = await makeThread({ replies: 1200 })
    await ensureConversationForComment(prisma, thread.rootId)
    expect(await prisma.agentMessage.count({ where: { conversationId: thread.rootId } })).toBe(1201)
    await deleteComments([thread.rootId, ...thread.replyIds])
    await remove(thread)
    expect(await prisma.agentMessage.count({ where: { conversationId: thread.rootId } })).toBe(0)
    expect(await conversation(thread.rootId)).toBeNull()
  }, 120_000)

  it("a panel post that commits during the purge conflicts, retries, and the conversation is archived, not destroyed", async () => {
    const thread = await makeThread({ replies: 1 })
    await ensureConversationForComment(prisma, thread.rootId)
    await deleteComments([thread.rootId, ...thread.replyIds])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let posted!: () => void
    const postedSignal = new Promise<void>((resolve) => { posted = resolve })
    // The panel turn: writes a message and the conversation row inside a transaction, and holds it open.
    const panel = prisma.$transaction(async (tx) => {
      await tx.agentMessage.create({ data: { conversationId: thread.rootId, role: "user", content: "panel post during delete", authorUserId: u.owner, createdAt: at(700) } })
      await tx.agentConversation.update({ where: { id: thread.rootId }, data: { summary: "panel post during delete" } })
      posted()
      await gate
    }, { timeout: 60_000 })
    await postedSignal
    const removal = remove(thread)
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    await panel
    await removal
    const row = await conversation(thread.rootId)
    expect(row).not.toBeNull()
    expect(row?.archivedAt).toBeInstanceOf(Date)
    expect((await prisma.agentMessage.findMany({ where: { conversationId: thread.rootId } })).map((m) => m.content)).toEqual(["panel post during delete"])
  }, 90_000)

  it("create-vs-delete race: a comment deleted while the mirror is being written leaves no ghost", async () => {
    const thread = await makeThread({ replies: 1 })
    let deleted = false
    const racing = new Proxy(prisma, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property !== "agentMessage") return value
        return new Proxy(value as object, {
          get(delegate, name, delegateReceiver) {
            const member = Reflect.get(delegate, name, delegateReceiver)
            if (name !== "upsert" || typeof member !== "function") return member
            return async (...args: unknown[]) => {
              if (!deleted) { deleted = true; await deleteComments([thread.rootId, ...thread.replyIds]) }
              return (member as (...a: unknown[]) => unknown).apply(delegate, args)
            }
          },
        })
      },
    }) as AppPrismaClient
    await expect(ensureConversationForComment(racing, thread.rootId)).resolves.toBeNull()
    expect(await conversation(thread.rootId)).toBeNull()
    expect(await messageIds(thread.rootId)).toEqual([])
  })

  it("tolerates optional tables that are not migrated (missing table inside the delete transaction)", async () => {
    const thread = await makeThread({ replies: 1 })
    await ensureConversationForComment(prisma, thread.rootId)
    await deleteComments([thread.rootId, ...thread.replyIds])
    await pool.query(`ALTER TABLE "${schema}".agent_web_fetches RENAME TO agent_web_fetches_hidden`)
    await pool.query(`ALTER TABLE "${schema}".agent_scheduled_wakeups RENAME TO agent_scheduled_wakeups_hidden`)
    try {
      await remove(thread)
    } finally {
      await pool.query(`ALTER TABLE "${schema}".agent_web_fetches_hidden RENAME TO agent_web_fetches`)
      await pool.query(`ALTER TABLE "${schema}".agent_scheduled_wakeups_hidden RENAME TO agent_scheduled_wakeups`)
    }
    expect(await conversation(thread.rootId)).toBeNull()
  })
})
