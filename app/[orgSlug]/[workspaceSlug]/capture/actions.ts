"use server"

import { redirect } from "next/navigation"
import { randomUUID } from "node:crypto"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { createResearchToken, normalizeResearchAppUrl, parseResearchGuide } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"
import { runResearchInterviewAgent } from "@/lib/research-agent"

export async function generateUsabilityTasks(
  orgSlug: string,
  workspaceSlug: string,
  input: { goal: string; appUrl: string; targetMinutes: number },
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
  const goal = input.goal.trim()
  if (!goal || goal.length > 5_000) throw new Error("Enter a research goal")
  const appUrl = normalizeResearchAppUrl(input.appUrl, {
    production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
  })
  if (![10, 15, 20, 30].includes(input.targetMinutes)) throw new Error("Unsupported study duration")
  const prompt = `You are helping a researcher prepare a moderated usability test.
Research goal: ${goal}
Product URL (context only; do not fetch or open it): ${appUrl}
Target duration: ${input.targetMinutes} minutes

Write realistic participant goals, not UI instructions. Avoid naming buttons, menus, or page locations. Each task must be distinct, concise, observable, neutral, and possible to attempt in the product. Return only a JSON array of 5 to 8 strings with no markdown or explanation.`
  const response = await runResearchInterviewAgent({ prompt, baseUrl: "https://compass.local" })
  let parsed: unknown
  try {
    parsed = JSON.parse(response)
  } catch {
    throw new Error("Compass could not generate an editable task guide")
  }
  if (
    !Array.isArray(parsed) || parsed.length < 5 || parsed.length > 8 ||
    parsed.some((task) => typeof task !== "string" || !task.trim() || task.trim().length > 1_000)
  ) throw new Error("Compass generated an invalid task guide")
  return parsed.map((task) => String(task).trim())
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
  if (studyType !== "CUSTOMER_INTERVIEW" && studyType !== "USABILITY_TEST") {
    throw new Error("Unsupported study type")
  }
  const targetMinutes = Number(formData.get("targetMinutes") ?? 15)
  if (![10, 15, 20, 30].includes(targetMinutes)) throw new Error("Unsupported study duration")
  const rawAppUrl = String(formData.get("appUrl") ?? "").trim()
  const appUrl = studyType === "USABILITY_TEST"
    ? normalizeResearchAppUrl(rawAppUrl, {
        production: !(process.env.NODE_ENV !== "production" && process.env.E2E_FUNCTIONAL === "1"),
      })
    : null
  const guide = parseResearchGuide(formData.getAll("guide").map(String))
  if (!name || !goal || guide.length === 0) throw new Error("Name, goal, and at least one question are required")
  if (name.length > 255) throw new Error("Study name must be 255 characters or fewer")
  if (goal.length > 5_000) throw new Error("Study goal must be 5,000 characters or fewer")
  if (guide.length > 20 || guide.some((item) => item.text.length > 1_000) || guide.reduce((total, item) => total + item.text.length, 0) > 10_000) {
    throw new Error("Use at most 20 guide questions, 1,000 characters each and 10,000 characters total")
  }
  const { token, tokenHash } = createResearchToken()
  const studyId = randomUUID()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await prisma.$transaction([
    prisma.researchStudy.create({ data: { id: studyId, workspaceId: workspace.id, name, goal, studyType, guide: JSON.stringify(guide), targetMinutes, appUrl, status: "ACTIVE", createdById: session.user.id, updatedById: session.user.id } }),
    prisma.researchParticipantToken.create({ data: { studyId, tokenHash, kind: "PRIMARY", expiresAt, createdById: session.user.id } }),
  ])
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${studyId}?token=${encodeURIComponent(token)}`)
}

export async function regenerateResearchLink(orgSlug: string, workspaceSlug: string, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findFirst({ where: { id: studyId, workspace: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } } }, select: { id: true, status: true } })
  if (!study) throw new Error("Study not found")
  if (study.status !== "ACTIVE") throw new Error("Participant links can only be rotated for an active study")
  const { token, tokenHash } = createResearchToken()
  const now = new Date()
  await prisma.$transaction([
    prisma.researchParticipantToken.updateMany({
      where: { studyId: study.id, kind: "PRIMARY", revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.researchParticipantToken.create({
      data: {
        studyId: study.id,
        tokenHash,
        kind: "PRIMARY",
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        createdById: session.user.id,
      },
    }),
    prisma.researchStudy.update({
      where: { id: study.id },
      data: { updatedAt: now, updatedById: session.user.id },
    }),
  ])
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}?token=${encodeURIComponent(token)}`)
}

export async function revokeResearchLinks(orgSlug: string, workspaceSlug: string, studyId: string) {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
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
    select: { id: true, status: true },
  })
  if (!study) throw new Error("Study not found")
  const now = new Date()
  await prisma.$transaction([
    prisma.researchParticipantToken.updateMany({
      where: { studyId: study.id, kind: "PRIMARY", revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.researchStudy.update({
      where: { id: study.id },
      data: { updatedAt: now, updatedById: session.user.id },
    }),
  ])
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}`)
}
