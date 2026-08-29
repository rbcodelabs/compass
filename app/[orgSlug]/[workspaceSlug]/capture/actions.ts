"use server"

import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { createResearchToken, parseResearchGuide } from "@/lib/research"

export async function createResearchStudy(orgSlug: string, workspaceSlug: string, formData: FormData) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } }, select: { id: true } })
  if (!workspace) throw new Error("Workspace not found")
  const name = String(formData.get("name") ?? "").trim()
  const goal = String(formData.get("goal") ?? "").trim()
  const guide = parseResearchGuide(formData.getAll("guide").map(String))
  if (!name || !goal || guide.length === 0) throw new Error("Name, goal, and at least one question are required")
  const { token, tokenHash } = createResearchToken()
  const study = await prisma.researchStudy.create({ data: { workspaceId: workspace.id, name, goal, guide: JSON.stringify(guide), targetMinutes: 15, status: "ACTIVE", shareTokenHash: tokenHash, shareExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), createdById: session.user.id, updatedById: session.user.id } })
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}?token=${encodeURIComponent(token)}`)
}

export async function regenerateResearchLink(orgSlug: string, workspaceSlug: string, studyId: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const prisma = getPrisma()
  const study = await prisma.researchStudy.findFirst({ where: { id: studyId, workspace: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId: session.user.id } } } }, select: { id: true } })
  if (!study) throw new Error("Study not found")
  const { token, tokenHash } = createResearchToken()
  await prisma.researchStudy.update({ where: { id: study.id }, data: { shareTokenHash: tokenHash, shareExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), status: "ACTIVE", updatedAt: new Date(), updatedById: session.user.id } })
  redirect(`/${orgSlug}/${workspaceSlug}/capture/studies/${study.id}?token=${encodeURIComponent(token)}`)
}
