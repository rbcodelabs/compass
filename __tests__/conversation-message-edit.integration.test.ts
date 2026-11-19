/**
 * Editing a message (lib/conversation-messages.ts, TASK-195 S1) against a real, disposable PostgreSQL schema.
 * The repo's updatedAt write extension bumps updatedAt on any update that omits it, so the point of this suite is that an
 * edit leaves the conversation's updatedAt (and therefore its place in every list) untouched while the message and the
 * mirrored Comment row both carry the edit instant. No schema change.
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

import { ensureConversationForComment } from "@/lib/conversation-mirror"
import { editConversationMessage } from "@/lib/conversation-messages"
import { getAgentConversationMessages } from "@/lib/agent-conversations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl
const BASE = new Date("2026-11-16T12:00:00.000Z").getTime()
const at = (minutes: number) => new Date(BASE + minutes * 60_000)

describe.skipIf(!databaseUrl)("conversation message edit (real PostgreSQL)", () => {
  const schema = `conversation_edit_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let workspaceId: string
  let opportunityId: string
  const u = {} as Record<"owner" | "replier" | "admin" | "stranger", string>

  async function makeThread(rootBody: string, replyBody: string, rootAt: number) {
    const rootId = randomUUID()
    const replyId = randomUUID()
    const common = { workspaceId, targetType: "OPPORTUNITY", targetId: opportunityId, authorType: "HUMAN", source: "UI", status: "OPEN" }
    await prisma.comment.create({ data: { ...common, id: rootId, parentId: null, body: rootBody, authorId: u.owner, authorName: "Owner", createdAt: at(rootAt), updatedAt: at(rootAt) } })
    await prisma.comment.create({ data: { ...common, id: replyId, parentId: rootId, body: replyBody, authorId: u.replier, authorName: "Replier", createdAt: at(rootAt + 1), updatedAt: at(rootAt + 1) } })
    await ensureConversationForComment(prisma, rootId)
    return { rootId, replyId }
  }
  const edit = (userId: string, conversationId: string, messageId: string, content: string) =>
    editConversationMessage({ conversationId, messageId, workspaceId, userId, content })
  const listOrder = async () =>
    (await prisma.agentConversation.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, select: { id: true } })).map((c) => c.id)

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
    const org = await prisma.organization.create({ data: { slug: `ce-${randomUUID().slice(0, 8)}`, name: "Conversation Edit" } })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org.id, slug: "ce", name: "CE" } })).id
    for (const key of ["owner", "replier", "admin", "stranger"] as const) u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    for (const key of ["owner", "replier", "admin"] as const) await prisma.workspaceMember.create({ data: { workspaceId, userId: u[key], role: key === "admin" ? "ADMIN" : "MEMBER" } })
    opportunityId = (await prisma.opportunity.create({ data: { workspaceId, title: "Edit target" } })).id
  }, 240_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  it("an author's edit updates message and Comment with the same instant and does not move the conversation in any list", async () => {
    const older = await makeThread("Older opener", "older reply", 0)
    const target = await makeThread("Opening line", "a reply", 100)
    const newer = await makeThread("Newest opener", "newest reply", 200)
    const orderBefore = await listOrder()
    const before = await prisma.agentConversation.findUniqueOrThrow({ where: { id: target.rootId } })

    const result = await edit(u.owner, target.rootId, target.rootId, "Rewritten **opening** line")
    expect(result.ok).toBe(true)

    const after = await prisma.agentConversation.findUniqueOrThrow({ where: { id: target.rootId } })
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(await listOrder()).toEqual(orderBefore)
    expect(orderBefore.indexOf(newer.rootId)).toBeLessThan(orderBefore.indexOf(target.rootId))
    expect(orderBefore.indexOf(target.rootId)).toBeLessThan(orderBefore.indexOf(older.rootId))
    // The auto-derived title followed the edited first message.
    expect(after.title).toBe("Rewritten **opening** line")

    const message = await prisma.agentMessage.findUniqueOrThrow({ where: { id: target.rootId } })
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: target.rootId } })
    expect(message.content).toBe("Rewritten **opening** line")
    expect(comment.body).toBe("Rewritten **opening** line")
    expect(message.editedAt).toBeInstanceOf(Date)
    expect(comment.updatedAt.getTime()).toBe(message.editedAt!.getTime())
    expect(comment.updatedAt.getTime()).toBeGreaterThan(comment.createdAt.getTime())
  })

  it("editing the last message refreshes the summary but still leaves updatedAt alone; a reply edit leaves the root untouched", async () => {
    const thread = await makeThread("Root words", "reply words", 300)
    const before = await prisma.agentConversation.findUniqueOrThrow({ where: { id: thread.rootId } })
    const result = await edit(u.replier, thread.rootId, thread.replyId, "reply rewritten")
    expect(result.ok).toBe(true)
    const after = await prisma.agentConversation.findUniqueOrThrow({ where: { id: thread.rootId } })
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime())
    expect(after.summary).toBe("reply rewritten")
    expect(after.title).toBe(before.title)
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.rootId } })).editedAt).toBeNull()
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: thread.replyId } })).body).toBe("reply rewritten")
  })

  it("authorization against real rows: a workspace admin may edit, another member gets 403, a non-member 404, nothing else changes", async () => {
    const thread = await makeThread("Guarded", "second", 400)
    const before = await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.replyId } })

    expect(await edit(u.owner, thread.rootId, thread.replyId, "owner tries")).toMatchObject({ ok: false, status: 403 })
    expect(await edit(u.stranger, thread.rootId, thread.replyId, "stranger tries")).toMatchObject({ ok: false, status: 404 })
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.replyId } })).content).toBe(before.content)

    expect((await edit(u.admin, thread.rootId, thread.replyId, "admin edit")).ok).toBe(true)
    const row = await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.replyId } })
    expect(row).toMatchObject({ content: "admin edit", authorUserId: u.replier })
    expect(row.editedAt).toBeInstanceOf(Date)
  })

  it("the messages read reports canEdit per caller and the editedAt after an edit", async () => {
    const thread = await makeThread("Read me", "and me", 500)
    await edit(u.owner, thread.rootId, thread.rootId, "Read me, edited")
    const asOwner = (await getAgentConversationMessages(thread.rootId, workspaceId, u.owner))!
    expect(asOwner.find((m) => m.id === thread.rootId)).toMatchObject({ canEdit: true, canDelete: false })
    expect(asOwner.find((m) => m.id === thread.rootId)!.editedAt).toBeInstanceOf(Date)
    expect(asOwner.find((m) => m.id === thread.replyId)!.canEdit).toBe(false)
    const asAdmin = (await getAgentConversationMessages(thread.rootId, workspaceId, u.admin))!
    expect(asAdmin.every((m) => m.canEdit)).toBe(true)
    expect(await getAgentConversationMessages(thread.rootId, workspaceId, u.stranger)).toBeNull()
  })

  it("a later mirror repair does not undo the edit", async () => {
    const thread = await makeThread("Repair root", "repair reply", 600)
    await edit(u.owner, thread.rootId, thread.rootId, "edited before repair")
    await ensureConversationForComment(prisma, thread.replyId)
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.rootId } })).content).toBe("edited before repair")
  })

  it("refuses to edit a plan proposal even when its mirror row still looks like an ordinary message", async () => {
    const thread = await makeThread("Proposal body", "ok", 700)
    // The race: the comment mirrored as a plain message, and only then was it marked as a proposal.
    await prisma.solutionPlanProposal.create({ data: { commentId: thread.rootId } })
    expect(await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.rootId } })).toMatchObject({ role: "user", messageKind: "COMMENT" })

    expect(await edit(u.owner, thread.rootId, thread.rootId, "tampered")).toMatchObject({ ok: false, status: 404 })
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: thread.rootId } })).content).toBe("Proposal body")
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: thread.rootId } })).body).toBe("Proposal body")
  })

  it("a later mirror repair or reply-delete does not turn an edit into new activity: the conversation keeps its place", async () => {
    const older = await makeThread("Older", "o", 800)
    const target = await makeThread("Target", "t", 900)
    const newer = await makeThread("Newer", "n", 1000)
    const order = await listOrder()
    const before = (await prisma.agentConversation.findUniqueOrThrow({ where: { id: target.rootId } })).updatedAt

    await edit(u.owner, target.rootId, target.rootId, "Target, edited")
    await edit(u.replier, target.rootId, target.replyId, "t, edited")
    await ensureConversationForComment(prisma, target.rootId)
    await ensureConversationForComment(prisma, target.replyId)

    const after = await prisma.agentConversation.findUniqueOrThrow({ where: { id: target.rootId } })
    expect(after.updatedAt.getTime()).toBe(before.getTime())
    expect(await listOrder()).toEqual(order)
    expect(order.indexOf(newer.rootId)).toBeLessThan(order.indexOf(target.rootId))
    expect(order.indexOf(target.rootId)).toBeLessThan(order.indexOf(older.rootId))
  })

  it("editing a message that an agent already answered starts no run and adds no message", async () => {
    const thread = await makeThread("Asked", "answered?", 1100)
    await prisma.agentMessage.create({ data: { conversationId: thread.rootId, role: "assistant", content: "the answer", createdAt: at(1110) } })
    const counts = async () => ({
      runs: await prisma.agentRun.count({ where: { conversationId: thread.rootId } }),
      messages: await prisma.agentMessage.count({ where: { conversationId: thread.rootId } }),
    })
    const before = await counts()
    expect((await edit(u.owner, thread.rootId, thread.rootId, "Asked, rephrased")).ok).toBe(true)
    expect(await counts()).toEqual(before)
  })

  it("a mirror-origin comment with no author is admin-only: the arbitrary owner the mirror picked cannot edit it and is not shown the edit control", async () => {
    const rootId = randomUUID()
    await prisma.comment.create({
      data: { id: rootId, workspaceId, targetType: "OPPORTUNITY", targetId: opportunityId, parentId: null, body: "Words from a deleted user", authorId: null, authorName: "Former member", authorType: "HUMAN", source: "UI", status: "OPEN", createdAt: at(1200), updatedAt: at(1200) },
    })
    await ensureConversationForComment(prisma, rootId)
    // The mirror had to pick some member as the conversation owner; it must not turn that member into the author.
    const ownerId = (await prisma.agentConversation.findUniqueOrThrow({ where: { id: rootId } })).userId
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: rootId } })).authorUserId).toBeNull()
    const canEditAs = async (userId: string) => (await getAgentConversationMessages(rootId, workspaceId, userId))!.find((m) => m.id === rootId)!.canEdit

    expect(await canEditAs(ownerId)).toBe(false)
    expect(await edit(ownerId, rootId, rootId, "Hijacked")).toMatchObject({ ok: false, status: 403 })
    expect((await prisma.agentMessage.findUniqueOrThrow({ where: { id: rootId } })).content).toBe("Words from a deleted user")

    expect(await canEditAs(u.admin)).toBe(true)
    expect((await edit(u.admin, rootId, rootId, "Moderated by an admin")).ok).toBe(true)
  })
})
