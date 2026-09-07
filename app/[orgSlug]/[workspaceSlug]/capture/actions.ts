"use server"

import { auth } from "@/auth"
import { redirect } from "next/navigation"
import * as studies from "@/lib/research-study-service"
import type { ResearchStudyType } from "@/lib/research"
import { isResearchCaptureEnabled } from "@/lib/research-feature"

async function actor() {
  if (!isResearchCaptureEnabled()) throw new Error("Research capture is not enabled")
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  return { userId: session.user.id, source: "UI" as const }
}
function input(form: FormData): studies.ResearchStudyInput {
  return { name: String(form.get("name") ?? ""), goal: String(form.get("goal") ?? ""), studyType: form.has("studyType") ? String(form.get("studyType")) : undefined, targetMinutes: Number(form.get("targetMinutes") ?? 15), appUrl: String(form.get("appUrl") ?? ""), guide: form.getAll("guide").map(String) }
}
function studyUrl(orgSlug: string, workspaceSlug: string, id: string, token?: string) {
  return `/${orgSlug}/${workspaceSlug}/capture/studies/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`
}
export async function generateResearchGuide(orgSlug: string, workspaceSlug: string, input: { studyType: ResearchStudyType; goal: string; appUrl: string; targetMinutes: number }) {
  return studies.generateResearchGuide({ orgSlug, workspaceSlug }, await actor(), input)
}
export async function createResearchStudy(orgSlug: string, workspaceSlug: string, formData: FormData) {
  const result = await studies.createResearchStudy({ orgSlug, workspaceSlug }, await actor(), input(formData))
  redirect(studyUrl(orgSlug, workspaceSlug, result.id, result.token))
}
export async function updateResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string, formData: FormData) {
  const result = await studies.updateResearchStudy({ orgSlug, workspaceSlug }, await actor(), studyId, input(formData))
  redirect(studyUrl(orgSlug, workspaceSlug, result.id))
}
export async function closeResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  const result = await studies.closeResearchStudy({ orgSlug, workspaceSlug }, await actor(), studyId)
  redirect(studyUrl(orgSlug, workspaceSlug, result.id))
}
export async function archiveResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  await studies.archiveResearchStudy({ orgSlug, workspaceSlug }, await actor(), studyId)
  redirect(`/${orgSlug}/${workspaceSlug}/capture`)
}
export async function activateResearchStudy(orgSlug: string, workspaceSlug: string, studyId: string) {
  const result = await studies.activateResearchStudy({ orgSlug, workspaceSlug }, await actor(), studyId)
  redirect(studyUrl(orgSlug, workspaceSlug, result.id, result.token))
}
export async function regenerateResearchLink(orgSlug: string, workspaceSlug: string, studyId: string) {
  const result = await studies.regenerateResearchLink({ orgSlug, workspaceSlug }, await actor(), studyId)
  redirect(studyUrl(orgSlug, workspaceSlug, result.id, result.token))
}
export async function revokeResearchLinks(orgSlug: string, workspaceSlug: string, studyId: string) {
  const result = await studies.revokeResearchLinks({ orgSlug, workspaceSlug }, await actor(), studyId)
  redirect(studyUrl(orgSlug, workspaceSlug, result.id))
}
