"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { getCapabilityPackArtifactStorage } from "@/lib/artifact-storage"
import { configureWorkspaceCapabilityPack, installCapabilityPack } from "@/lib/capability-pack-service"
import { resolveWorkspaceAdmin } from "@/lib/permissions"
import { parseGithubPackSource } from "@/lib/capability-pack"
import { resolveAgenticPmPackSource } from "@/lib/capability-pack-github"
import { AGENTIC_PM_PACK } from "@/lib/capability-pack-curated"
import { describePackUpdate, mergeSkillSelection, type PackSkill } from "@/lib/capability-pack-update"
import type { AppPrismaClient } from "@/lib/db"

function findCuratedAttachment(prisma: AppPrismaClient, workspaceId: string) {
  return prisma.workspaceCapabilityPack.findFirst({
    where: {
      workspaceId,
      capabilityPackVersion: { sourceRepository: AGENTIC_PM_PACK.repositoryUrl, sourcePath: AGENTIC_PM_PACK.packPath, capabilityPack: { workspaceId, packId: AGENTIC_PM_PACK.packId } },
    },
    include: { capabilityPackVersion: true },
  })
}

/**
 * Compare the workspace's selected Agentic PM version against the playbook's
 * current `main`. Read-only, and run on demand from the panel rather than during
 * the settings page render so a slow or rate-limited GitHub never delays the page.
 */
export async function checkAgenticPmPackUpdate(orgSlug: string, workspaceSlug: string) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  try {
    const attachment = await findCuratedAttachment(prisma, workspaceId)
    if (!attachment) return { error: "The Agentic PM pack is not installed in this workspace." }
    const latest = await resolveAgenticPmPackSource()
    return describePackUpdate(attachment.capabilityPackVersion.sourceCommit, latest.commitSha)
  } catch (cause) {
    logFailure("check", cause)
    return { error: "Unable to check for Agentic PM pack updates. GitHub may be unavailable or rate-limited; try again later." }
  }
}

/**
 * Install the playbook's current `main` as a new immutable version and select it.
 * The previous version stays installed, so rolling back is still one dropdown change.
 * Enabled state and skill choices carry over (see mergeSkillSelection).
 */
export async function updateAgenticPmCapabilityPack(orgSlug: string, workspaceSlug: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  try {
    const attachment = await findCuratedAttachment(prisma, workspaceId)
    if (!attachment) return { error: "Install the Agentic PM pack before updating it." }
    const current = attachment.capabilityPackVersion
    const source = await resolveAgenticPmPackSource()
    if (source.commitSha === current.sourceCommit) return { updated: false as const, commit: source.commitSha }
    const version = await installCapabilityPack({ ...source, workspaceId, createdById: session.user.id, expectedPackId: AGENTIC_PM_PACK.packId }, { prisma, storage: getCapabilityPackArtifactStorage() })
    const previous = JSON.parse(current.manifestJson) as { skills: PackSkill[] }
    const next = JSON.parse(version.manifestJson) as { skills: PackSkill[] }
    const enabledSkillIds = mergeSkillSelection({ skills: previous.skills, enabledSkillIds: JSON.parse(attachment.enabledSkillIds) as string[] }, next)
    await configureWorkspaceCapabilityPack({ workspaceId, packVersionId: version.id, enabledSkillIds, enabled: attachment.enabled }, prisma)
    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`)
    return { updated: true as const, commit: source.commitSha }
  } catch (cause) {
    logFailure("update", cause)
    // The failed install leaves the previously selected version untouched.
    return { error: "Unable to update the Agentic PM pack. Your installed version is unchanged. Try again, or ask an administrator to check GitHub availability, pack compatibility and private pack storage." }
  }
}

export async function installAgenticPmCapabilityPack(orgSlug: string, workspaceSlug: string) {
  const session = await auth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
  try {
    const existing = await prisma.workspaceCapabilityPack.findFirst({ where: {
      workspaceId,
      capabilityPackVersion: { sourceRepository: AGENTIC_PM_PACK.repositoryUrl, sourcePath: AGENTIC_PM_PACK.packPath, capabilityPack: { workspaceId, packId: AGENTIC_PM_PACK.packId } },
    } })
    if (!existing) {
      const source = await resolveAgenticPmPackSource()
      const version = await installCapabilityPack({ ...source, workspaceId, createdById: session.user.id, expectedPackId: AGENTIC_PM_PACK.packId }, { prisma, storage: getCapabilityPackArtifactStorage() })
      const manifest = JSON.parse(version.manifestJson) as { enabledSkills: string[] }
      // Concurrent first installs may validate different commits; the first
      // attachment wins and later calls never reset its version or selections.
      await configureWorkspaceCapabilityPack({ workspaceId, packVersionId: version.id, enabledSkillIds: manifest.enabledSkills, enabled: true, preserveExisting: true }, prisma)
    }
    revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`)
    return { installed: true }
  } catch (cause) {
    logFailure("install", cause)
    return { error: "Unable to install the Agentic PM pack. Try again, or ask an administrator to check GitHub availability, pack compatibility and private pack storage." }
  }
}

function logFailure(operation: "install" | "configure" | "check" | "update", cause: unknown) {
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
