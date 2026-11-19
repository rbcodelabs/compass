/**
 * TASK-195 S4 against a real, disposable PostgreSQL schema: a task-bearing root post made from the Conversations section
 * (POST /api/comments -> postTargetCommentWithOptionalTask) leaves ONE consistent state: the Comment, its mirrored
 * conversation and message (same ids), the task with its provenance links, and nothing else: no agent run, and no updatedAt
 * moved on rows the post did not own (the repo's Prisma updatedAt extension stamps `now` on any update that omits it).
 * A failed task leaves no comment and no stray conversation or message. No schema change.
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

const connection = vi.hoisted(() => ({ prisma: null as AppPrismaClient | null, userId: "", failTask: false }))
vi.mock("@/lib/db", () => ({ default: () => connection.prisma }))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: connection.userId } }) }))
vi.mock("@/lib/task-create", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/task-create")>()
  return {
    ...actual,
    createWorkspaceTask: (...args: Parameters<typeof actual.createWorkspaceTask>) => {
      if (connection.failTask) { connection.failTask = false; return Promise.reject(new Error("forced task failure")) }
      return actual.createWorkspaceTask(...args)
    },
  }
})

import { postTargetCommentWithOptionalTask } from "@/lib/comment-target-tasks"
import { loadConversationTaskCards, loadTaskComposerContext } from "@/lib/conversation-task-cards"
import { serializeMention } from "@/lib/comment-mentions"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

const databaseUrl = integrationDatabaseUrl
const BASE = new Date("2026-11-16T12:00:00.000Z").getTime()
const at = (minutes: number) => new Date(BASE + minutes * 60_000)
const SECRET = "Body text that must not be left behind by a failed task"

describe.skipIf(!databaseUrl)("conversation task row (real PostgreSQL)", () => {
  const schema = `conversation_task_row_${randomUUID().replaceAll("-", "")}`
  let pool: Pool
  let prisma: AppPrismaClient
  let created = false
  let workspaceId: string
  let opportunityId: string
  const u = {} as Record<"author" | "assignee", string>

  const tableCount = async (table: string, where: string, params: unknown[]) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".${table} WHERE ${where}`, params)).rows[0].n)
  const mention = () => serializeMention({ kind: "user", id: u.assignee, label: "Assignee" })
  const post = (body: string, extra: Record<string, unknown> = {}) =>
    postTargetCommentWithOptionalTask({
      workspaceId, targetType: "OPPORTUNITY", targetId: opportunityId, userId: u.author, userName: "Author", body,
      task: { title: "Do the thing", dueDate: null, priority: "HIGH" }, assignee: null, ...extra,
    })

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
    const org = await prisma.organization.create({ data: { slug: `tr-${randomUUID().slice(0, 8)}`, name: "Task Row" } })
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org.id, slug: "tr", name: "TR" } })).id
    for (const key of ["author", "assignee"] as const) u[key] = (await prisma.user.create({ data: { email: `${key}-${randomUUID().slice(0, 6)}@localhost.dev`, name: key } })).id
    for (const key of ["author", "assignee"] as const) await prisma.workspaceMember.create({ data: { workspaceId, userId: u[key], role: "MEMBER" } })
    connection.userId = u.author
    opportunityId = (await prisma.opportunity.create({ data: { workspaceId, title: "Task row target" } })).id
  }, 240_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
  })

  it("creates the comment, its mirrored conversation and message, the task and its provenance in one consistent state, with no agent run", async () => {
    // A thread on the same item that the post does not own: its row must not move.
    const otherId = randomUUID()
    await prisma.agentConversation.create({ data: { id: otherId, userId: u.assignee, workspaceId, title: "Other thread", visibility: "WORKSPACE", targetType: "OPPORTUNITY", targetId: opportunityId, createdAt: at(0), updatedAt: at(5) } })
    const targetBefore = await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { updatedAt: true } })

    const body = `Can you draft this? ${mention()}`
    const result = await post(body)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const commentId = result.comment.id

    // Comment + mirror, same ids, no extra rows.
    expect(await prisma.comment.findUnique({ where: { id: commentId }, select: { parentId: true, authorId: true } })).toEqual({ parentId: null, authorId: u.author })
    const conversation = await prisma.agentConversation.findUnique({ where: { id: commentId } })
    expect(conversation).toMatchObject({ id: commentId, userId: u.author, visibility: "WORKSPACE", targetType: "OPPORTUNITY", targetId: opportunityId, agentMode: "MENTION_ONLY" })
    const messages = await prisma.agentMessage.findMany({ where: { conversationId: commentId } })
    expect(messages.map((m) => [m.id, m.messageKind, m.role])).toEqual([[commentId, "COMMENT", "user"]])
    expect(messages[0]!.content).toBe(body)

    // The task, assigned to the mentioned person, with both provenance links.
    const task = await prisma.task.findUnique({ where: { id: result.card!.taskId } })
    expect(task).toMatchObject({ workspaceId, assigneeUserId: u.assignee, priority: "HIGH", title: "Do the thing" })
    expect(await tableCount("entity_links", "from_id = $1 AND link_type = 'TASK_CREATED_FROM' AND to_id = $2", [task!.id, commentId])).toBe(1)
    expect(await tableCount("entity_links", "from_id = $1 AND link_type = 'TASK_REFERENCES' AND to_id = $2", [task!.id, opportunityId])).toBe(1)
    expect(await tableCount("tasks", "workspace_id = $1", [workspaceId])).toBe(1)

    // Read side: the card the panel and the section row render, and the composer context.
    expect((await loadConversationTaskCards(workspaceId, [commentId, otherId]))[commentId]).toMatchObject({ taskId: task!.id, title: "Do the thing", assignee: { type: "USER", id: u.assignee } })
    expect(await loadConversationTaskCards(workspaceId, [otherId])).toEqual({})
    expect(await loadTaskComposerContext(workspaceId, "OPPORTUNITY", opportunityId)).toMatchObject({ confirmedAgentIds: [], targetTitle: "Task row target" })

    // No chat turn: no agent run anywhere in the workspace, and no assistant message.
    expect(await tableCount("agent_runs", "workspace_id = $1", [workspaceId])).toBe(0)
    expect(await tableCount("agent_messages", "conversation_id = $1 AND role = 'assistant'", [commentId])).toBe(0)

    // Rows the post does not own did not move.
    expect((await prisma.agentConversation.findUnique({ where: { id: otherId }, select: { updatedAt: true } }))!.updatedAt.getTime()).toBe(at(5).getTime())
    expect((await prisma.opportunity.findUnique({ where: { id: opportunityId }, select: { updatedAt: true } }))!.updatedAt.getTime()).toBe(targetBefore!.updatedAt.getTime())
    // The new conversation's activity time is the comment's, not "whenever the mirror ran".
    const comment = await prisma.comment.findUnique({ where: { id: commentId }, select: { createdAt: true } })
    expect(conversation!.updatedAt.getTime()).toBe(comment!.createdAt.getTime())
  })

  it("a failed task leaves no comment, no conversation and no message behind", async () => {
    connection.failTask = true
    const before = {
      comments: await tableCount("comments", "workspace_id = $1", [workspaceId]),
      conversations: await tableCount("agent_conversations", "workspace_id = $1", [workspaceId]),
      messages: await tableCount("agent_messages", "content LIKE $1", [`%${SECRET}%`]),
    }
    const result = await post(`${SECRET} ${mention()}`)
    expect(result).toMatchObject({ ok: false, error: "TASK_FAILED" })
    expect(await tableCount("comments", "workspace_id = $1", [workspaceId])).toBe(before.comments)
    expect(await tableCount("agent_conversations", "workspace_id = $1", [workspaceId])).toBe(before.conversations)
    expect(before.messages).toBe(0)
    expect(await tableCount("agent_messages", "content LIKE $1", [`%${SECRET}%`])).toBe(0)
    expect(await tableCount("tasks", "workspace_id = $1", [workspaceId])).toBe(1)
    expect(await tableCount("agent_runs", "workspace_id = $1", [workspaceId])).toBe(0)
  })

  it("a plain mention without a task still makes a comment and mirror but no task and no run", async () => {
    const result = await post(`FYI ${mention()}`, { task: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.agentMessage.count({ where: { conversationId: result.comment.id } })).toBe(1)
    expect(await tableCount("tasks", "workspace_id = $1", [workspaceId])).toBe(1)
    expect(await tableCount("agent_runs", "workspace_id = $1", [workspaceId])).toBe(0)
  })
})
