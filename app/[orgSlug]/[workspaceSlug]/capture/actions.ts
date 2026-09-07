"use server"

import { redirect } from "next/navigation"
import { randomUUID } from "node:crypto"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { createResearchToken, normalizeResearchAppUrl, parseResearchGuide, type ResearchStudyType } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { runResearchInterviewAgent } from "@/lib/research-agent"

const SUPPORTED_DURATIONS = [10, 15, 20, 30]

function assertStudyType(value: string): asserts value is ResearchStudyType {
  if (value !== "CUSTOMER_INTERVIEW" && value !== "USABILITY_TEST") throw new Error("Unsupported study type")
}

function assertDuration(value: number) {
  if (!SUPPORTED_DURATIONS.includes(value)) throw new Error("Unsupported study duration")
}

function validateGuide(formData: FormData) {
  const guide = parseResearchGuide(formData.getAll("guide").map(String))
  if (guide.length === 0) throw new Error("Add at least one guide question")
  if (guide.length > 20 || guide.some((item) => item.text.length > 1_000) || guide.reduce((total, item) => total + item.text.length, 0) > 10_000) {
    throw new Error("Use at most 20 guide questions, 1,000 characters each and 10,000 characters total")
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
  orgSlug: string,
  workspaceSlug: string,
  input: { studyType: ResearchStudyType; goal: string; appUrl: string; targetMinutes: number },
) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      organization: { slug: orgSlug },
      members: { some: { userId: session.user.id } },
    },
    select: { id: true },
  })
  if (!workspace) throw new Error("Workspace not found")
  assertStudyType(input.studyType)
  const goal = input.goal.trim()
  if (!goal || goal.length > 5_000) throw new Error("Enter a research goal")
  assertDuration(input.targetMinutes)
  const guided = input.studyType === "USABILITY_TEST"
  const appUrl = guided ? normalizeResearchAppUrl(input.appUrl, {
    production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
  }) : null
  const prompt = guided ? `You are helping a researcher prepare a moderated usability test.
Research goal: ${goal}
Product URL (context only; do not fetch or open it): ${appUrl}
Target duration: ${input.targetMinutes} minutes

Write realistic participant goals, not UI instructions. Avoid naming buttons, menus, or page locations. Each task must be distinct, concise, observable, neutral, and possible to attempt in the product. Return only a JSON array of 5 to 8 strings with no markdown or explanation.` : `You are helping a researcher prepare a customer discovery interview.
Research goal: ${goal}
Target duration: ${input.targetMinutes} minutes

Write neutral, open-ended questions about concrete past behavior and real experiences. Do not validate assumptions, pitch solutions, ask leading questions, or combine multiple questions. Each question must be distinct, concise, and conversational. Return only a JSON array of 5 to 8 strings with no markdown or explanation.`
  const response = await runResearchInterviewAgent({ prompt, baseUrl: "https://compass.local" })
  let parsed: unknown
  try {
    parsed = JSON.parse(response)
  } catch {
    throw new Error("Compass could not generate an editable study guide")
  }
  if (
    !Array.isArray(parsed) || parsed.length < 5 || parsed.length > 8 ||
    parsed.some((task) => typeof task !== "string" || !task.trim() || task.trim().length > 1_000)
  ) throw new Error("Compass generated an invalid study guide")
  const items = parsed.map((task) => String(task).trim())
  if (new Set(items.map((item) => item.toLocaleLowerCase())).size !== items.length) {
    throw new Error("Compass generated an invalid study guide")
  }
  return items
}

export async function createResearchStudy(orgSlug: string, workspaceSlug: string, formData: FormData) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true } })
  if (!workspace) throw new Error("Workspace not found")
  const name = String(formData.get("name") ?? "").trim()
  const goal = String(formData.get("goal") ?? "").trim()
  const studyType = String(formData.get("studyType") ?? "CUSTOMER_INTERVIEW")
  assertStudyType(studyType)
  const targetMinutes = Number(formData.get("targetMinutes") ?? 15)
  assertDuration(targetMinutes)
  const rawAppUrl = String(formData.get("appUrl") ?? "").trim()
  const appUrl = studyType === "USABILITY_TEST"
    ? normalizeResearchAppUrl(rawAppUrl, {
        production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
      })
    : null
  const guide = validateGuide(formData)
  if (!name || !goal || guide.length === 0) throw new Error("Name, goal, and at least one question are required")
  if (name.length > 255) throw new Error("Study name must be 255 characters or fewer")
  if (goal.length > 5_000) throw new Error("Study goal must be 5,000 characters or fewer")
  const { token, tokenHash } = createResearchToken()
  const studyId = randomUUID()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await prisma.$transaction([
    prisma.researchStudy.create({ data: { id: studyId, workspaceId: workspace.id, name, goal, studyType, guide: JSON.stringify(guide), targetMinutes, appUrl, status: "ACTIVE", createdById: session.user.id, updatedById: session.user.id } }),
    prisma.researchParticipantToken.create({ data: { studyId, tokenHash, kind: "PRIMARY", expiresAt, createdById: session.user.id } }),
  ])
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${studyId}?token=${encodeURIComponent(token)}`)
}

async function findMemberStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findFirst({
    where: {
      id: studyId,
      workspace: {
        slug: workspaceSlug,
        organization: { slug: orgSlug },
        members: { some: { userId: session.user.id } },
      },
    },
    select: {
      id: true, status: true, studyType: true, goal: true, guide: true,
      targetMinutes: true, appUrl: true, _count: { select: { sessions: true } },
    },
  })
  if (!study) throw new Error("Study not found")
  return { prisma, userId: session.user.id, study }
}

export async function updateResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string, formData: FormData) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(orgSlug, workspaceSlug, studyId)
  if (study.status === "ARCHIVED") throw new Error("Archived studies cannot be edited")
  const name = String(formData.get("name") ?? "").trim()
  if (!name) throw new Error("Enter a study name")
  if (name.length > 255) throw new Error("Study name must be 255 characters or fewer")

  let protocol = {
    studyType: study.studyType,
    goal: study.goal,
    guide: study.guide,
    targetMinutes: study.targetMinutes,
    appUrl: study.appUrl,
  }
  if (study._count.sessions === 0) {
    const studyType = String(formData.get("studyType") ?? study.studyType)
    assertStudyType(studyType)
    const goal = String(formData.get("goal") ?? "").trim()
    if (!goal) throw new Error("Enter a research goal")
    if (goal.length > 5_000) throw new Error("Study goal must be 5,000 characters or fewer")
    const targetMinutes = Number(formData.get("targetMinutes") ?? 15)
    assertDuration(targetMinutes)
    const guide = validateGuide(formData)
    const appUrl = studyType === "USABILITY_TEST" ? normalizeResearchAppUrl(String(formData.get("appUrl") ?? ""), {
      production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
    }) : null
    protocol = { studyType, goal, guide: JSON.stringify(guide), targetMinutes, appUrl }
  }
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const locked = await tx.researchStudy.updateMany({
      where: { id: study.id, status: { not: "ARCHIVED" } },
      data: { updatedAt: now, updatedById: userId },
    })
    if (locked.count !== 1) throw new Error("Study changed before it could be saved")
    const sessionCount = await tx.researchSession.count({ where: { studyId: study.id } })
    await tx.researchStudy.update({
      where: { id: study.id },
      data: sessionCount === 0
        ? { name, ...protocol, updatedAt: now, updatedById: userId }
        : { name, updatedAt: now, updatedById: userId },
    })
  }))
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}`)
}

async function endResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string, status: "CLOSED" | "ARCHIVED") {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(orgSlug, workspaceSlug, studyId)
  if (study.status === "ARCHIVED") throw new Error("Archived studies cannot change lifecycle state")
  if (status === "CLOSED" && study.status !== "ACTIVE") throw new Error("Only active studies can be closed")
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const allowed = status === "CLOSED" ? ["ACTIVE"] : ["DRAFT", "ACTIVE", "CLOSED"]
    const changed = await tx.researchStudy.updateMany({ where: { id: study.id, status: { in: allowed } }, data: { status, updatedAt: now, updatedById: userId } })
    if (changed.count !== 1) throw new Error("Study lifecycle changed before it could be saved")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
  }))
  redirect(`/${orgSlug}/${workspaceSlug}/capture${status === "CLOSED" ? `/studies/${study.id}` : ""}`)
}

export async function closeResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  return endResearchStudy(orgSlug, workspaceSlug, studyId, "CLOSED")
}

export async function archiveResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  return endResearchStudy(orgSlug, workspaceSlug, studyId, "ARCHIVED")
}

export async function activateResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(orgSlug, workspaceSlug, studyId)
  if (study.status !== "CLOSED" && study.status !== "DRAFT") throw new Error("Only draft or closed studies can be activated")
  const { token, tokenHash } = createResearchToken()
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const changed = await tx.researchStudy.updateMany({ where: { id: study.id, status: { in: ["DRAFT", "CLOSED"] } }, data: { status: "ACTIVE", updatedAt: now, updatedById: userId } })
    if (changed.count !== 1) throw new Error("Study lifecycle changed before it could be activated")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
    await tx.researchParticipantToken.create({ data: { studyId: study.id, tokenHash, kind: "PRIMARY", expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), createdById: userId } })
  }))
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}?token=${encodeURIComponent(token)}`)
}

export async function regenerateResearchLink(orgSlug: string, workspaceSlug: string, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(orgSlug, workspaceSlug, studyId)
  if (study.status !== "ACTIVE") throw new Error("Participant links can only be rotated for an active study")
  const { token, tokenHash } = createResearchToken()
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const active = await tx.researchStudy.updateMany({ where: { id: study.id, status: "ACTIVE" }, data: { updatedAt: now, updatedById: userId } })
    if (active.count !== 1) throw new Error("Study lifecycle changed before its link could be rotated")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
    await tx.researchParticipantToken.create({ data: { studyId: study.id, tokenHash, kind: "PRIMARY", expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), createdById: userId } })
  }))
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}?token=${encodeURIComponent(token)}`)
}

export async function revokeResearchLinks(orgSlug: string, workspaceSlug: string, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const { prisma, userId, study } = await findMemberStudy(orgSlug, workspaceSlug, studyId)
  if (study.status !== "ACTIVE") throw new Error("Participant links can only be revoked for an active study")
  const now = new Date()
  await retryResearchTransaction(() => prisma.$transaction(async (tx) => {
    const active = await tx.researchStudy.updateMany({ where: { id: study.id, status: "ACTIVE" }, data: { updatedAt: now, updatedById: userId } })
    if (active.count !== 1) throw new Error("Study lifecycle changed before its links could be revoked")
    await tx.researchParticipantToken.updateMany({ where: { studyId: study.id, kind: "PRIMARY", revokedAt: null }, data: { revokedAt: now } })
  }))
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}`)
}
