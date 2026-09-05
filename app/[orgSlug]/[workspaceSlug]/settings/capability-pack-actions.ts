"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { configureWorkspaceCapabilityPack, installCapabilityPack } from "@/lib/capability-pack-service"
import { resolveWorkspaceAdmin } from "@/lib/permissions"

export async function installWorkspaceCapabilityPack(orgSlug: string, workspaceSlug: string, input: { repositoryUrl: string; commitSha: string; packPath: string }) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  const version = await installCapabilityPack({ ...input, createdById: session.user.id, workspaceId }, { prisma, storage: getArtifactStorage() })
  const manifest = JSON.parse(version.manifestJson) as { enabledSkills: string[] }
  await configureWorkspaceCapabilityPack({ workspaceId, packVersionId: version.id, enabledSkillIds: manifest.enabledSkills, enabled: true }, prisma)
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`)
  return { id: version.id }
}

export async function updateWorkspaceCapabilityPack(orgSlug: string, workspaceSlug: string, input: { packVersionId: string; enabledSkillIds: string[]; enabled: boolean }) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  await configureWorkspaceCapabilityPack({ workspaceId, ...input }, prisma)
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`)
}
