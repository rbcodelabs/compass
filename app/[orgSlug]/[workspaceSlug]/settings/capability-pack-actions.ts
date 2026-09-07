"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { getCapabilityPackArtifactStorage } from "@/lib/artifact-storage"
import { configureWorkspaceCapabilityPack, installCapabilityPack } from "@/lib/capability-pack-service"
import { resolveWorkspaceAdmin } from "@/lib/permissions"
import { parseGithubPackSource } from "@/lib/capability-pack"

function logFailure(operation: "install" | "configure", cause: unknown) {
  // Names are allowlisted: custom provider names/messages can contain input or credentials.
  const knownNames = new Set(["Error", "TypeError", "BlobError", "BlobAccessError", "BlobStoreNotFoundError", "BlobServiceNotAvailable", "BlobServiceRateLimited", "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError"])
  const errorName = cause instanceof Error && knownNames.has(cause.name) ? cause.name : "UnknownError"
  console.error("Capability pack operation failed", { operation, errorName })
}

export async function installWorkspaceCapabilityPack(orgSlug: string, workspaceSlug: string, input: { repositoryUrl: string; commitSha: string; packPath: string }) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  try {
    parseGithubPackSource(input.repositoryUrl, input.commitSha, input.packPath)
  } catch (cause) {
    // This pure validator only handles the caller's source fields. Returning
    // expected errors keeps Next's production exception redaction out of the UI.
    return { error: cause instanceof Error ? cause.message : "Invalid capability pack source" }
  }
  try {
    const version = await installCapabilityPack({ ...input, createdById: session.user.id, workspaceId }, { prisma, storage: getCapabilityPackArtifactStorage() })
    const manifest = JSON.parse(version.manifestJson) as { enabledSkills: string[] }
    await configureWorkspaceCapabilityPack({ workspaceId, packVersionId: version.id, enabledSkillIds: manifest.enabledSkills, enabled: true }, prisma)
    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`)
    return { id: version.id }
  } catch (cause) {
    logFailure("install", cause)
    // Never serialize provider/database exceptions or credentials to a client.
    return { error: "Unable to install this capability pack. Check the repository, commit and pack path. If they are correct, ask an administrator to check private pack storage." }
  }
}

export async function updateWorkspaceCapabilityPack(orgSlug: string, workspaceSlug: string, input: { packVersionId: string; enabledSkillIds: string[]; enabled: boolean }) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  try {
    await configureWorkspaceCapabilityPack({ workspaceId, ...input }, prisma)
    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`)
  } catch (cause) {
    logFailure("configure", cause)
    return { error: "Unable to save capability pack settings. Reload to confirm the current selection, then ask an administrator to check the selected version and private pack storage." }
  }
}
