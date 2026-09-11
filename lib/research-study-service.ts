import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Prisma } from "@prisma/client"
import getPrisma from "@/lib/db"
import { createResearchToken, normalizeResearchAppUrl, parseResearchGuide, type ResearchStudyType } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { runResearchInterviewAgent } from "@/lib/research-agent"

export class ResearchStudyError extends Error {}

export type ResearchStudyActor = { userId: string | null; service?: boolean; source?: "UI" | "MCP" }
export type ResearchWorkspaceScope = { workspaceId: string } | { orgSlug: string; workspaceSlug: string }
export type ResearchStudyInput = { name: string; goal?: string; studyType?: string; targetMinutes?: number; appUrl?: string; guide?: string[] }

function workspaceWhere(scope: ResearchWorkspaceScope, actor: ResearchStudyActor): Prisma.WorkspaceWhereInput {
  if (!actor.userId && !(actor.service === true && actor.userId === null)) throw new ResearchStudyError("Unauthorized")
  return {
    ...("workspaceId" in scope ? { id: scope.workspaceId } : { slug: scope.workspaceSlug, organization: { slug: scope.orgSlug } }),
    ...(actor.userId ? { members: { some: { userId: actor.userId } } } : {}),
  }
}

const SUPPORTED_DURATIONS = [10, 15, 20, 30]

function assertStudyType(value: string): asserts value is ResearchStudyType {
  if (value !== "CUSTOMER_INTERVIEW" && value !== "USABILITY_TEST") throw new ResearchStudyError("Unsupported study type")
}

function assertDuration(value: number) {
  if (!SUPPORTED_DURATIONS.includes(value)) throw new ResearchStudyError("Unsupported study duration")
}

function validateGuide(input: ResearchStudyInput) {
  const guide = parseResearchGuide(input.guide ?? [])
  if (guide.length === 0) throw new ResearchStudyError("Add at least one guide question")
  if (guide.length > 20 || guide.some((item) => item.text.length > 1_000) || guide.reduce((total, item) => total + item.text.length, 0) > 10_000) {
    throw new ResearchStudyError("Use at most 20 guide questions, 1,000 characters each and 10,000 characters total")
  }
  return guide
}

async function retryResearchTransaction<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if ((error as { code?: string }).code !== "P2034" || attempt === attempts - 1) throw error
    }
  }
  throw lastError
}

export async function generateResearchGuide(
  scope: ResearchWorkspaceScope,
  actor: ResearchStudyActor,
  input: { studyType: ResearchStudyType; goal: string; appUrl: string; targetMinutes: number },
  deadline?: number,
) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: workspaceWhere(scope, actor),
    select: { id: true },
  })
  if (!workspace) throw new ResearchStudyError("Workspace not found")
  assertStudyType(input.studyType)
  const goal = input.goal.trim()
  if (!goal || goal.length > 5_000) throw new ResearchStudyError("Enter a research goal")
  assertDuration(input.targetMinutes)
  const guided = input.studyType === "USABILITY_TEST"
  const appUrl = guided ? normalizeResearchAppUrl(input.appUrl, {
    production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
  }) : null
  const prompt = guided ? `You are helping a researcher prepare a moderated usability test.
Research goal: ${goal}
Product URL (context only; do not fetch or open it): ${appUrl}
Target duration: ${input.targetMinutes} minutes

Write realistic participant goals, not UI instructions. Avoid naming buttons, menus, or page locations. Cover the core journey and relevant edge cases without assuming an implementation. Do not invent product capabilities from the URL. Each task must be distinct, concise, observable, neutral, and possible to attempt in the product. Return only a JSON array of 5 to 8 strings with no markdown or explanation.` : `You are helping a researcher prepare a customer discovery interview.
Research goal: ${goal}
Target duration: ${input.targetMinutes} minutes

Write neutral, open-ended questions about concrete past behavior and real experiences. Cover current workarounds and unmet needs before inviting a description of an ideal experience, grounded in those experiences rather than hypothetical purchase intent. Do not validate assumptions, pitch solutions, ask leading questions, or combine multiple questions. Each question must be distinct, concise, and conversational. Return only a JSON array of 5 to 8 strings with no markdown or explanation.`
  const response = await runResearchInterviewAgent({ prompt, baseUrl: "https://compass.local", ...(deadline === undefined ? {} : { deadline }) })
  let parsed: unknown
  try {
    parsed = JSON.parse(response.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""))
  } catch {
    throw new ResearchStudyError("Compass could not generate an editable study guide")
  }
  if (
    !Array.isArray(parsed) || parsed.length < 5 || parsed.length > 8 ||
    parsed.some((task) => typeof task !== "string" || !task.trim() || task.trim().length > 1_000)
  ) throw new ResearchStudyError("Compass generated an invalid study guide")
  const items = parsed.map((task) => String(task).trim())
  if (new Set(items.map((item) => item.toLocaleLowerCase())).size !== items.length) {
    throw new ResearchStudyError("Compass generated an invalid study guide")
  }
  return items
}

export async function createResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, input: ResearchStudyInput) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: workspaceWhere(scope, actor), select: { id: true } })
  if (!workspace) throw new ResearchStudyError("Workspace not found")
  const name = String(input.name ?? "").trim()
  const goal = String(input.goal ?? "").trim()
  const studyType = String(input.studyType ?? "CUSTOMER_INTERVIEW")
  assertStudyType(studyType)
  const targetMinutes = Number(input.targetMinutes ?? 15)
  assertDuration(targetMinutes)
  const rawAppUrl = String(input.appUrl ?? "").trim()
  const appUrl = studyType === "USABILITY_TEST"
    ? normalizeResearchAppUrl(rawAppUrl, {
        production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
      })
    : null
  const guide = validateGuide(input)
  if (!name || !goal || guide.length === 0) throw new ResearchStudyError("Name, goal, and at least one question are required")
  if (name.length > 255) throw new ResearchStudyError("Study name must be 255 characters or fewer")
  if (goal.length > 5_000) throw new ResearchStudyError("Study goal must be 5,000 characters or fewer")
  const { token, tokenHash } = createResearchToken()
  const studyId = randomUUID()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await prisma.$transaction([
    prisma.researchStudy.create({ data: { id: studyId, workspaceId: workspace.id, name, goal, studyType, guide: JSON.stringify(guide), targetMinutes, appUrl, status: "ACTIVE", source: actor.source ?? "UI", createdById: actor.userId, updatedById: actor.userId } }),
    prisma.researchParticipantToken.create({ data: { studyId, tokenHash, kind: "PRIMARY", expiresAt, createdById: actor.userId } }),
  ])
  return { id: studyId, token }
}

async function findMemberStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findFirst({
    where: {
      id: studyId,
      workspace: workspaceWhere(scope, actor),
    },
    select: {
      id: true, name: true, workspaceId: true, createdAt: true, updatedAt: true, status: true, studyType: true, goal: true, guide: true,
      targetMinutes: true, appUrl: true, _count: { select: { sessions: true } },
    },
  })
  if (!study) throw new ResearchStudyError("Study not found")
  return { prisma, userId: actor.userId, study }
}

export async function updateResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string, input: ResearchStudyInput) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status === "ARCHIVED") throw new ResearchStudyError("Archived studies cannot be edited")
  const name = String(input.name ?? "").trim()
  if (!name) throw new ResearchStudyError("Enter a study name")
  if (name.length > 255) throw new ResearchStudyError("Study name must be 255 characters or fewer")

  let protocol: Partial<{ studyType: string; goal: string; guide: string; targetMinutes: number; appUrl: string | null }> = {}
  if (study._count.sessions === 0) {
    const studyType = String(input.studyType ?? study.studyType)
    assertStudyType(studyType)
    const goal = String(input.goal ?? study.goal).trim()
    if (!goal) throw new ResearchStudyError("Enter a research goal")
    if (goal.length > 5_000) throw new ResearchStudyError("Study goal must be 5,000 characters or fewer")
    const targetMinutes = Number(input.targetMinutes ?? study.targetMinutes)
    assertDuration(targetMinutes)
    const guide = input.guide === undefined ? JSON.parse(study.guide) : validateGuide(input)
    const appUrl = studyType === "USABILITY_TEST" ? normalizeResearchAppUrl(String(input.appUrl ?? study.appUrl ?? ""), {
      production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
    }) : null
    protocol = {
      ...(input.studyType === undefined ? {} : { studyType }),
      ...(input.goal === undefined ? {} : { goal }),
      ...(input.guide === undefined ? {} : { guide: JSON.stringify(guide) }),
      ...(input.targetMinutes === undefined ? {} : { targetMinutes }),
      ...(input.appUrl === undefined && input.studyType === undefined ? {} : { appUrl }),
    }
  }
  const now = new Date(Math.max(Date.now(), (study.updatedAt?.getTime() ?? 0) + 1))
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const locked = await tx.researchStudy.updateMany({
      where: { id: study.id, status: { not: "ARCHIVED" }, updatedAt: study.updatedAt },
      data: { updatedAt: now, updatedById: userId },
    })
    if (locked.count !== 1) throw new ResearchStudyError("Study changed before it could be saved")
    const sessionCount = await tx.researchSession.count({ where: { studyId: study.id } })
    await tx.researchStudy.update({
      where: { id: study.id },
      data: sessionCount === 0
        ? { name, ...protocol, updatedAt: now, updatedById: userId }
        : { name, updatedAt: now, updatedById: userId },
    })
  }))
  return { id: study.id }
}

async function endResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string, status: "CLOSED" | "ARCHIVED") {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status === "ARCHIVED") throw new ResearchStudyError("Archived studies cannot change lifecycle state")
  if (status === "CLOSED" && study.status !== "ACTIVE") throw new ResearchStudyError("Only active studies can be closed")
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const allowed = status === "CLOSED" ? ["ACTIVE"] : ["DRAFT", "ACTIVE", "CLOSED"]
    const changed = await tx.researchStudy.updateMany({ where: { id: study.id, status: { in: allowed } }, data: { status, updatedAt: now, updatedById: userId } })
    if (changed.count !== 1) throw new ResearchStudyError("Study lifecycle changed before it could be saved")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
  }))
  return { id: study.id, status }
}

export async function closeResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  return endResearchStudy(scope, actor, studyId, "CLOSED")
}

export async function archiveResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  return endResearchStudy(scope, actor, studyId, "ARCHIVED")
}

export async function activateResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status !== "CLOSED" && study.status !== "DRAFT") throw new ResearchStudyError("Only draft or closed studies can be activated")
  const { token, tokenHash } = createResearchToken()
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const changed = await tx.researchStudy.updateMany({ where: { id: study.id, status: { in: ["DRAFT", "CLOSED"] } }, data: { status: "ACTIVE", updatedAt: now, updatedById: userId } })
    if (changed.count !== 1) throw new ResearchStudyError("Study lifecycle changed before it could be activated")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
    await tx.researchParticipantToken.create({ data: { studyId: study.id, tokenHash, kind: "PRIMARY", expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), createdById: userId } })
  }))
  return { id: study.id, token }
}

export async function regenerateResearchLink(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status !== "ACTIVE") throw new ResearchStudyError("Participant links can only be rotated for an active study")
  const { token, tokenHash } = createResearchToken()
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const active = await tx.researchStudy.updateMany({ where: { id: study.id, status: "ACTIVE" }, data: { updatedAt: now, updatedById: userId } })
    if (active.count !== 1) throw new ResearchStudyError("Study lifecycle changed before its link could be rotated")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
    await tx.researchParticipantToken.create({ data: { studyId: study.id, tokenHash, kind: "PRIMARY", expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), createdById: userId } })
  }))
  return { id: study.id, token }
}

export async function revokeResearchLinks(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status !== "ACTIVE") throw new ResearchStudyError("Participant links can only be revoked for an active study")
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const active = await tx.researchStudy.updateMany({ where: { id: study.id, status: "ACTIVE" }, data: { updatedAt: now, updatedById: userId } })
    if (active.count !== 1) throw new ResearchStudyError("Study lifecycle changed before its links could be revoked")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
  }))
  return { id: study.id }
}

export async function issueResearchLink(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status !== "ACTIVE") throw new ResearchStudyError("Participant links require an active study")
  const { token, tokenHash } = createResearchToken()
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async tx => {
    const locked = await tx.researchStudy.updateMany({ where: { id: study.id, status: "ACTIVE" }, data: { updatedAt: now, updatedById: userId } })
    if (locked.count !== 1) throw new ResearchStudyError("Study changed before its link could be issued")
    const live = await tx.researchParticipantToken.findFirst({ where: { studyId, kind: "PRIMARY", revokedAt: null, expiresAt: { gt: now } }, select: { id: true } })
    if (live) throw new ResearchStudyError("A participant link already exists; explicitly rotate it to create a replacement")
    await tx.researchParticipantToken.create({ data: { studyId, tokenHash, kind: "PRIMARY", expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), createdById: userId } })
  }))
  return { id: study.id, token }
}

const metadataSelect = { id: true, workspaceId: true, name: true, goal: true, studyType: true, guide: true, targetMinutes: true, appUrl: true, status: true, createdAt: true, updatedAt: true, _count: { select: { sessions: true } } } satisfies Prisma.ResearchStudySelect
type StudyMetadata = Prisma.ResearchStudyGetPayload<{ select: typeof metadataSelect }>
function publicMetadata(study: StudyMetadata) {
  return { id: study.id, workspaceId: study.workspaceId, name: study.name, goal: study.goal, studyType: study.studyType, guide: JSON.parse(study.guide), targetMinutes: study.targetMinutes, appUrl: study.appUrl, status: study.status, createdAt: study.createdAt, updatedAt: study.updatedAt, sessionCount: study._count.sessions }
}

export async function getResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  return publicMetadata((await findMemberStudy(scope, actor, studyId)).study)
}

const cursorSchema = z.object({ version: z.literal(1), workspaceId: z.string().uuid(), status: z.enum(["DRAFT", "ACTIVE", "CLOSED", "ARCHIVED"]).nullable(), createdAt: z.string().datetime(), id: z.string().uuid() }).strict()
export async function listResearchStudies(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, { limit = 20, status, cursor }: { limit?: number; status?: "DRAFT" | "ACTIVE" | "CLOSED" | "ARCHIVED"; cursor?: string }) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: workspaceWhere(scope, actor), select: { id: true } })
  if (!workspace) throw new ResearchStudyError("Workspace not found")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ResearchStudyError("Limit must be between 1 and 100")
  let after: z.infer<typeof cursorSchema> | undefined
  if (cursor !== undefined) {
    try {
      if (cursor.length > 1_024) throw new ResearchStudyError()
      after = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
      if (after.workspaceId !== workspace.id || after.status !== (status ?? null)) throw new ResearchStudyError()
    } catch { throw new ResearchStudyError("Invalid research cursor for this workspace or status") }
  }
  const studies = await prisma.researchStudy.findMany({
    where: { workspaceId: workspace.id, status: status ?? { not: "ARCHIVED" }, ...(after ? { OR: [{ createdAt: { lt: new Date(after.createdAt) } }, { createdAt: new Date(after.createdAt), id: { lt: after.id } }] } : {}) },
    select: metadataSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
  })
  const page = studies.slice(0, limit)
  const last = page.at(-1)
  return { items: page.map(publicMetadata), count: page.length, nextCursor: studies.length > limit && last ? Buffer.from(JSON.stringify({ version: 1, workspaceId: workspace.id, status: status ?? null, createdAt: last.createdAt.toISOString(), id: last.id })).toString("base64url") : null }
}
