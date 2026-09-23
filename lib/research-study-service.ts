import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Prisma } from "@prisma/client"
import getPrisma from "@/lib/db"
import { createResearchToken, normalizeResearchAppUrl, parseResearchGuide, type ResearchStudyType } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { runResearchInterviewAgent } from "@/lib/research-agent"
import { readSessionAnalysis, readStudySynthesis } from "@/lib/research-analysis"
import { getStudyExperiments } from "@/lib/experiment-research-links"

export class ResearchStudyError extends Error {}

/** Lifecycle states a ResearchSession row can hold (schema: VarChar(20)). */
export const RESEARCH_SESSION_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED", "ABANDONED", "EXPIRED"] as const
export type ResearchSessionStatus = (typeof RESEARCH_SESSION_STATUSES)[number]

export type ResearchStudyActor = { userId: string | null; service?: boolean; source?: "UI" | "MCP" }
export type ResearchWorkspaceScope = { workspaceId: string } | { orgSlug: string; workspaceSlug: string }
export type ResearchStudyInput = { name: string; goal?: string; studyType?: string; targetMinutes?: number; appUrl?: string; artifactId?: string; guide?: string[]; status?: "DRAFT" | "ACTIVE" }

const CREATABLE_STATUSES = ["DRAFT", "ACTIVE"] as const
function assertCreatableStatus(value: string): asserts value is (typeof CREATABLE_STATUSES)[number] {
  if (!CREATABLE_STATUSES.includes(value as (typeof CREATABLE_STATUSES)[number])) throw new ResearchStudyError("Unsupported initial status")
}

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

type UsabilityTestTarget = { appUrl: string | null; artifactId: string | null; artifactTitle: string | null }

/**
 * A USABILITY_TEST study has exactly one target: a live appUrl or a Compass
 * Artifact (HTML_UPLOAD, ACTIVE, in this workspace). Shared by
 * createResearchStudy, updateResearchStudy and generateResearchGuide so the
 * "exactly one" rule and the artifact scoping query live in one place.
 */
async function resolveUsabilityTestTarget(
  prisma: ReturnType<typeof getPrisma>,
  workspaceId: string,
  raw: { appUrl?: string; artifactId?: string },
  options: { production: boolean },
): Promise<UsabilityTestTarget> {
  const appUrlValue = String(raw.appUrl ?? "").trim()
  const artifactIdValue = String(raw.artifactId ?? "").trim()
  if (appUrlValue && artifactIdValue) throw new ResearchStudyError("Provide either a product URL or an artifact, not both")
  if (!appUrlValue && !artifactIdValue) throw new ResearchStudyError("Enter a product URL or select an artifact")
  if (artifactIdValue) {
    const artifact = await prisma.artifact.findFirst({
      where: { id: artifactIdValue, workspaceId, status: "ACTIVE", sourceType: "HTML_UPLOAD" },
      select: { id: true, title: true },
    })
    if (!artifact) throw new ResearchStudyError("Artifact not found")
    return { appUrl: null, artifactId: artifact.id, artifactTitle: artifact.title }
  }
  return { appUrl: normalizeResearchAppUrl(appUrlValue, options), artifactId: null, artifactTitle: null }
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
  input: { studyType: ResearchStudyType; goal: string; appUrl?: string; artifactId?: string; artifactTitle?: string; targetMinutes: number },
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
  // The UI already knows the selected artifact's title (it rendered the
  // picker from the workspace's artifact list) so it can skip a redundant
  // re-validation round trip for this ephemeral, non-persisting drafting
  // call. An artifactId (MCP, or any caller without a title in hand) still
  // goes through the same scoped lookup createResearchStudy uses.
  const rawArtifactTitle = String(input.artifactTitle ?? "").trim()
  let targetLine = ""
  if (guided) {
    if (rawArtifactTitle) {
      targetLine = `Target: an interactive prototype (title: ${rawArtifactTitle})`
    } else {
      const target = await resolveUsabilityTestTarget(prisma, workspace.id, { appUrl: input.appUrl, artifactId: input.artifactId }, {
        production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
      })
      targetLine = target.artifactId
        ? `Target: an interactive prototype (title: ${target.artifactTitle})`
        : `Product URL (context only; do not fetch or open it): ${target.appUrl}`
    }
  }
  const prompt = guided ? `You are helping a researcher prepare a moderated usability test.
Research goal: ${goal}
${targetLine}
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
  const target = studyType === "USABILITY_TEST"
    ? await resolveUsabilityTestTarget(prisma, workspace.id, { appUrl: input.appUrl, artifactId: input.artifactId }, {
        production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
      })
    : { appUrl: null, artifactId: null, artifactTitle: null }
  const guide = validateGuide(input)
  if (!name || !goal || guide.length === 0) throw new ResearchStudyError("Name, goal, and at least one question are required")
  if (name.length > 255) throw new ResearchStudyError("Study name must be 255 characters or fewer")
  if (goal.length > 5_000) throw new ResearchStudyError("Study goal must be 5,000 characters or fewer")
  const status = String(input.status ?? "ACTIVE")
  assertCreatableStatus(status)
  const studyId = randomUUID()
  const studyCreate = prisma.researchStudy.create({ data: { id: studyId, workspaceId: workspace.id, name, goal, studyType, guide: JSON.stringify(guide), targetMinutes, appUrl: target.appUrl, artifactId: target.artifactId, status, source: actor.source ?? "UI", createdById: actor.userId, updatedById: actor.userId } })
  // DRAFT stages the study without issuing a participant link — activate_research_study
  // remains the single explicit step that transitions to ACTIVE and mints one.
  if (status === "DRAFT") {
    await prisma.$transaction([studyCreate])
    return { id: studyId, status }
  }
  const { token, tokenHash } = createResearchToken()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await prisma.$transaction([
    studyCreate,
    prisma.researchParticipantToken.create({ data: { studyId, tokenHash, kind: "PRIMARY", expiresAt, createdById: actor.userId } }),
  ])
  return { id: studyId, status, token }
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
      targetMinutes: true, appUrl: true, artifactId: true, _count: { select: { sessions: true } },
    },
  })
  if (!study) throw new ResearchStudyError("Study not found")
  if (study.studyType === "PM_INTERVIEW") throw new ResearchStudyError("Study not found")
  return { prisma, userId: actor.userId, study }
}

export async function updateResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string, input: ResearchStudyInput) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(scope, actor, studyId)
  if (study.status === "ARCHIVED") throw new ResearchStudyError("Archived studies cannot be edited")
  const name = String(input.name ?? "").trim()
  if (!name) throw new ResearchStudyError("Enter a study name")
  if (name.length > 255) throw new ResearchStudyError("Study name must be 255 characters or fewer")

  let protocol: Partial<{ studyType: string; goal: string; guide: string; targetMinutes: number; appUrl: string | null; artifactId: string | null }> = {}
  if (study._count.sessions === 0) {
    const studyType = String(input.studyType ?? study.studyType)
    assertStudyType(studyType)
    const goal = String(input.goal ?? study.goal).trim()
    if (!goal) throw new ResearchStudyError("Enter a research goal")
    if (goal.length > 5_000) throw new ResearchStudyError("Study goal must be 5,000 characters or fewer")
    const targetMinutes = Number(input.targetMinutes ?? study.targetMinutes)
    assertDuration(targetMinutes)
    const guide = input.guide === undefined ? JSON.parse(study.guide) : validateGuide(input)
    // Fall back to whichever target the study already carries when the
    // caller doesn't explicitly touch appUrl/artifactId this update — the
    // same "resend the current value" contract appUrl already had, extended
    // to two mutually exclusive fields instead of one.
    const appUrlFallback = study.artifactId ? undefined : (study.appUrl ?? undefined)
    const artifactIdFallback = study.artifactId ?? undefined
    const target = studyType === "USABILITY_TEST"
      ? await resolveUsabilityTestTarget(prisma, study.workspaceId, {
          appUrl: input.appUrl !== undefined ? input.appUrl : (input.artifactId !== undefined ? undefined : appUrlFallback),
          artifactId: input.artifactId !== undefined ? input.artifactId : (input.appUrl !== undefined ? undefined : artifactIdFallback),
        }, {
          production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
        })
      : { appUrl: null, artifactId: null, artifactTitle: null }
    protocol = {
      ...(input.studyType === undefined ? {} : { studyType }),
      ...(input.goal === undefined ? {} : { goal }),
      ...(input.guide === undefined ? {} : { guide: JSON.stringify(guide) }),
      ...(input.targetMinutes === undefined ? {} : { targetMinutes }),
      ...(input.appUrl === undefined && input.artifactId === undefined && input.studyType === undefined
        ? {}
        : { appUrl: target.appUrl, artifactId: target.artifactId }),
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

const metadataSelect = { id: true, workspaceId: true, name: true, goal: true, studyType: true, guide: true, targetMinutes: true, appUrl: true, artifactId: true, status: true, createdAt: true, updatedAt: true, _count: { select: { sessions: true } } } satisfies Prisma.ResearchStudySelect
type StudyMetadata = Prisma.ResearchStudyGetPayload<{ select: typeof metadataSelect }>
function publicMetadata(study: StudyMetadata) {
  return { id: study.id, workspaceId: study.workspaceId, name: study.name, goal: study.goal, studyType: study.studyType, guide: JSON.parse(study.guide), targetMinutes: study.targetMinutes, appUrl: study.appUrl, artifactId: study.artifactId, status: study.status, createdAt: study.createdAt, updatedAt: study.updatedAt, sessionCount: study._count.sessions }
}

export async function getResearchStudy(scope: ResearchWorkspaceScope, actor: ResearchStudyActor, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { study } = await findMemberStudy(scope, actor, studyId)
  return { ...publicMetadata(study), experiments: await getStudyExperiments(study.workspaceId, study.id) }
}

/**
 * Transcript reads (ADR-0012 step 3).
 *
 * `ResearchSession` stores participant identity (`participantName`,
 * `participantEmail`), credential material (`resumeTokenHash`,
 * `participantTokenId`), a raw media pointer (`audioUrl`) and voice/request
 * operational state (`voiceLease*`, `activeRequest*`, `nextSequence`). None of
 * it may ever reach a model, so the projection is enforced twice and
 * independently:
 *
 *   1. `sessionSelect` never loads those columns from the database, and
 *   2. `publicSession()` rebuilds its result field by field — it never spreads a
 *      row — so widening the select (or adding a column to the model) cannot
 *      leak by default. This is the control the tests assert against.
 *
 * `summary` is the one selected column that is deliberately NOT returned. It is
 * overloaded: it holds either a legacy plaintext summary or the JSON envelope
 * written by lib/research-analysis.ts, which during generation also carries
 * analysis-lease internals (claim ids, deadlines, failure markers). Returning it
 * raw would expose that machinery and would let a stale or in-flight claim read
 * as a finished summary, so it is reduced to a `hasSummary` boolean through the
 * existing hardened parser. Exposing synthesis content is ADR-0012 step 4's job.
 */
const sessionSelect = {
  id: true, studyId: true, modality: true, status: true, startedAt: true, completedAt: true,
  lastActiveAt: true, endedReason: true, createdAt: true, summary: true, _count: { select: { turns: true } },
} satisfies Prisma.ResearchSessionSelect
type SessionMetadata = Prisma.ResearchSessionGetPayload<{ select: typeof sessionSelect }>
function publicSession(session: SessionMetadata) {
  return {
    id: session.id, studyId: session.studyId, modality: session.modality, status: session.status,
    startedAt: session.startedAt, completedAt: session.completedAt, lastActiveAt: session.lastActiveAt,
    endedReason: session.endedReason, createdAt: session.createdAt,
    turnCount: session._count.turns,
    hasSummary: Boolean(readSessionAnalysis(session.summary).summary),
  }
}

/** Ordered participant/interviewer text — the point of the tool, and safe. */
const turnSelect = { id: true, role: true, content: true, sequence: true } satisfies Prisma.ResearchTurnSelect

const PAGE_SIZE = 20
/** Bounded here as well as in the tool's zod schema; the service is also called directly. */
function assertOffset(offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) throw new ResearchStudyError("Offset must be a whole number between 0 and 1,000,000")
}

/**
 * Sessions page in creation order so that a session starting mid-read appends
 * to the end instead of shifting every subsequent offset page.
 */
export async function listResearchSessions(
  scope: ResearchWorkspaceScope,
  actor: ResearchStudyActor,
  studyId: string,
  { status, offset = 0 }: { status?: ResearchSessionStatus; offset?: number } = {},
) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  // findMemberStudy enforces workspace membership AND excludes PM_INTERVIEW
  // studies, which reuse these tables but have their own owner-scoped
  // authorization path (ADR-0011). Resolving through it is what stops these
  // tools becoming a PM-interview transcript backdoor.
  const { prisma, study } = await findMemberStudy(scope, actor, studyId)
  assertOffset(offset)
  const sessions = await prisma.researchSession.findMany({
    where: { studyId: study.id, ...(status ? { status } : {}) },
    select: sessionSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: offset, take: PAGE_SIZE + 1,
  })
  const page = sessions.slice(0, PAGE_SIZE)
  return { studyId: study.id, items: page.map(publicSession), count: page.length, nextOffset: sessions.length > PAGE_SIZE ? offset + PAGE_SIZE : null }
}

export async function getResearchSession(
  scope: ResearchWorkspaceScope,
  actor: ResearchStudyActor,
  studyId: string,
  sessionId: string,
  { offset = 0 }: { offset?: number } = {},
) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, study } = await findMemberStudy(scope, actor, studyId)
  assertOffset(offset)
  // Scoped to the already-authorized study, so a session id from another study
  // (including a PM interview's) resolves to nothing rather than to its turns.
  const session = await prisma.researchSession.findFirst({ where: { id: sessionId, studyId: study.id }, select: sessionSelect })
  if (!session) throw new ResearchStudyError("Session not found")
  const turns = await prisma.researchTurn.findMany({
    where: { sessionId: session.id }, select: turnSelect,
    orderBy: { sequence: "asc" }, skip: offset, take: PAGE_SIZE + 1,
  })
  // Spreads the allowlisted projection's own return value, never the database row.
  return { ...publicSession(session), turns: turns.slice(0, PAGE_SIZE), nextOffset: turns.length > PAGE_SIZE ? offset + PAGE_SIZE : null }
}

/**
 * Versioned synthesis history (ADR-0012 step 4).
 *
 * EXPOSURE DECISION — `CROSS_SESSION` rows only.
 *
 * `ResearchSynthesis.content` is overloaded by the generation lease. While a row
 * is `PENDING` its `content` is the *claim blob*: `{version, sourceFingerprint,
 * claimId, deadline}`. The `FAILED` transition only rewrites `kind` and
 * `updatedAt`, so a FAILED row's `content` is that same claim blob forever.
 * Neither is a synthesis, and both would hand a model the lease's internal
 * identifiers and timing — so neither row's content is returned.
 *
 * Nor are the rows themselves. The only thing their existence conveys is "a
 * generation is running / failed", and a separate read is the wrong place to
 * learn that: it is stale the moment it returns, whereas
 * `generate_research_synthesis` answers the same question race-free by either
 * taking the lease or returning "Synthesis already in progress". Exposing a
 * second, weaker signal would invite the agent to branch on the stale one.
 *
 * Content is re-validated on the way out through `readStudySynthesis`, the same
 * hardened reader the UI uses, because persisted analysis is still untrusted. A
 * row that does not parse is returned with `content: null` rather than dropped,
 * so the history's shape and counts stay honest.
 */
export async function listResearchSyntheses(
  scope: ResearchWorkspaceScope,
  actor: ResearchStudyActor,
  studyId: string,
  { offset = 0 }: { offset?: number } = {},
) {
  if (!isResearchCaptureEnabled()) throw new ResearchStudyError("Research capture is not enabled")
  const { prisma, study } = await findMemberStudy(scope, actor, studyId)
  assertOffset(offset)
  const rows = await prisma.researchSynthesis.findMany({
    where: { studyId: study.id, kind: "CROSS_SESSION" },
    select: { id: true, content: true, sessionCount: true, model: true, promptVersion: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: offset, take: PAGE_SIZE + 1,
  })
  const page = rows.slice(0, PAGE_SIZE)
  return {
    studyId: study.id,
    items: page.map(row => ({ id: row.id, sessionCount: row.sessionCount, model: row.model, promptVersion: row.promptVersion, createdAt: row.createdAt, content: readStudySynthesis(row.content) })),
    count: page.length,
    nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
  }
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
