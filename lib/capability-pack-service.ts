import type { PrismaClient } from "@prisma/client"
import type { ArtifactStorage } from "@/lib/artifact-storage"
import { getArtifactStorage } from "@/lib/artifact-storage"
import { fetchGithubCapabilityPack } from "@/lib/capability-pack-github"
import { normalizeCapabilityPack, parseGithubPackSource, verifyCapabilityPackArtifact } from "@/lib/capability-pack"
import { compileCapabilityPackInstructions } from "@/lib/capability-pack-compilation"
import { assertPackHostCompatibility } from "@/lib/capability-pack-runtime"
import { createHash } from "node:crypto"

export async function installCapabilityPack(input: {
  repositoryUrl: string
  commitSha: string
  packPath: string
  createdById: string
  workspaceId: string
}, deps: { prisma: PrismaClient; storage: ArtifactStorage; fetcher?: typeof fetch }) {
  const source = parseGithubPackSource(input.repositoryUrl, input.commitSha, input.packPath)
  const files = await fetchGithubCapabilityPack(input, deps.fetcher)
  const artifact = normalizeCapabilityPack(files)
  assertPackHostCompatibility(artifact.manifest.sdkCompatibility, artifact.manifest.requiredHostCapabilities)
  compileCapabilityPackInstructions(artifact, artifact.manifest.enabledSkills)
  const artifactPathname = `capability-packs/sha256/${artifact.digest}.json`
  const sourceKey = createHash("sha256").update(`${input.repositoryUrl.replace(/\/$/, "")}\n${source.packPath}`).digest("hex")
  const existingBytes = await deps.storage.get(artifactPathname)
  if (existingBytes && Buffer.compare(Buffer.from(existingBytes), Buffer.from(artifact.bytes)) !== 0) throw new Error("Capability pack digest collision")
  if (!existingBytes) await deps.storage.put(artifactPathname, artifact.bytes, "application/json; charset=utf-8")

  try {
    const capabilityPack = await deps.prisma.capabilityPack.upsert({
      where: { workspaceId_packId_sourceKey: { workspaceId: input.workspaceId, packId: artifact.manifest.id, sourceKey } },
      update: {},
      create: { workspaceId: input.workspaceId, packId: artifact.manifest.id, sourceKey, displayName: artifact.manifest.displayName },
    })
    return await deps.prisma.capabilityPackVersion.upsert({
      where: { capabilityPackId_semanticVersion_sourceCommit: { capabilityPackId: capabilityPack.id, semanticVersion: artifact.manifest.version, sourceCommit: source.commitSha } },
      update: {},
      create: {
        capabilityPackId: capabilityPack.id,
        semanticVersion: artifact.manifest.version,
        sourceRepository: input.repositoryUrl.replace(/\/$/, ""),
        sourceCommit: source.commitSha,
        sourcePath: source.packPath,
        artifactSha256: artifact.digest,
        artifactPathname,
        sdkCompatibility: artifact.manifest.sdkCompatibility,
        manifestJson: JSON.stringify(artifact.manifest),
        validationStatus: "VALID",
        createdById: input.createdById,
      },
    })
  } catch (error) {
    // The digest path is immutable and deduplicated. Leaving it behind is safe;
    // a later identical install will reuse it, avoiding a delete/create race.
    throw error
  }
}

export async function configureWorkspaceCapabilityPack(input: {
  workspaceId: string
  packVersionId: string
  enabledSkillIds: string[]
  enabled: boolean
}, prisma: PrismaClient, storage?: Pick<ArtifactStorage, "get">) {
  const version = await prisma.capabilityPackVersion.findFirst({ where: { id: input.packVersionId, capabilityPack: { workspaceId: input.workspaceId } }, include: { capabilityPack: { select: { workspaceId: true, packId: true } } } })
  if (!version || version.validationStatus !== "VALID") throw new Error("Validated capability pack version not found")
  const manifest = JSON.parse(version.manifestJson) as { sdkCompatibility: string; requiredHostCapabilities: string[]; skills: Array<{ id: string }> }
  assertPackHostCompatibility(manifest.sdkCompatibility, manifest.requiredHostCapabilities)
  const declared = new Set(manifest.skills.map((skill) => skill.id))
  const enabledSkillIds = [...new Set(input.enabledSkillIds)].sort()
  if (enabledSkillIds.some((id) => !declared.has(id))) throw new Error("Enabled skill is not declared by this pack")
  if (input.enabled) {
    const bytes = await (storage ?? getArtifactStorage()).get(version.artifactPathname)
    if (!bytes) throw new Error("Capability pack artifact not found")
    const artifact = verifyCapabilityPackArtifact(bytes, version.artifactSha256)
    if (artifact.manifest.id !== version.capabilityPack.packId || artifact.manifest.version !== version.semanticVersion) throw new Error("Capability pack metadata mismatch")
    compileCapabilityPackInstructions(artifact, enabledSkillIds)
  }
  return prisma.workspaceCapabilityPack.upsert({
    where: { workspaceId_capabilityPackId: { workspaceId: input.workspaceId, capabilityPackId: version.capabilityPackId } },
    update: { capabilityPackVersionId: version.id, enabledSkillIds: JSON.stringify(enabledSkillIds), enabled: input.enabled, updatedAt: new Date() },
    create: { workspaceId: input.workspaceId, capabilityPackId: version.capabilityPackId, capabilityPackVersionId: version.id, enabledSkillIds: JSON.stringify(enabledSkillIds), enabled: input.enabled },
  })
}
