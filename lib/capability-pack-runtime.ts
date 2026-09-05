import type { ArtifactStorage } from "@/lib/artifact-storage"
import { verifyCapabilityPackArtifact } from "@/lib/capability-pack"

export type ActiveCapabilityPack = {
  packId: string
  version: string
  commit: string
  digest: string
  pathname: string
  enabledSkills: string[]
  manifestJson: string
}

export type SandboxPackFile = { path: string; content: Uint8Array }

const HOST_SDK_VERSION = "0.3.224"

function supportsHostSdk(range: string): boolean {
  // The v1 pack contract intentionally recognizes the exact version or a
  // conventional range that includes the pinned 0.3.224 host. Broader semver
  // evaluation would require a dependency and is unnecessary while the SDK is pinned.
  return range === HOST_SDK_VERSION || range === `=${HOST_SDK_VERSION}` || /(?:>=\s*)?0\.3\.224\b/.test(range)
}

export async function prepareCapabilityPacksForTurn(
  active: ActiveCapabilityPack[],
  storage: Pick<ArtifactStorage, "get">
): Promise<{ files: SandboxPackFile[]; pluginPaths: string[]; skillIds: string[]; provenanceJson: string; systemPromptAppendices: string[] }> {
  const files: SandboxPackFile[] = []
  const pluginPaths: string[] = []
  const skillIds: string[] = []
  const systemPromptAppendices: string[] = []
  const seenSkills = new Set<string>()
  const provenance: Array<{ id: string; version: string; commit: string; digest: string; enabledSkills: string[] }> = []

  for (const item of [...active].sort((a, b) => a.packId.localeCompare(b.packId))) {
    const bytes = await storage.get(item.pathname)
    if (!bytes) throw new Error(`Capability pack artifact not found: ${item.packId}@${item.version}`)
    const artifact = verifyCapabilityPackArtifact(bytes, item.digest)
    if (artifact.manifest.id !== item.packId || artifact.manifest.version !== item.version) throw new Error(`Capability pack metadata mismatch: ${item.packId}`)
    if (!supportsHostSdk(artifact.manifest.sdkCompatibility)) throw new Error(`Capability pack is incompatible with Agent SDK ${HOST_SDK_VERSION}: ${item.packId}`)
    const declared = new Set(artifact.manifest.skills.map((skill) => skill.id))
    for (const skill of item.enabledSkills) {
      if (!declared.has(skill)) throw new Error(`Enabled skill is not declared by ${item.packId}: ${skill}`)
      if (seenSkills.has(skill)) throw new Error(`Duplicate skill id across active packs: ${skill}`)
      seenSkills.add(skill)
      skillIds.push(`${item.packId}:${skill}`)
    }
    const directory = `capability-packs/${item.packId}-${item.version}`
    pluginPaths.push(directory)
    for (const file of artifact.files) files.push({ path: `${directory}/${file.path}`, content: new Uint8Array(Buffer.from(file.contentBase64, "base64")) })
    if (artifact.manifest.systemPromptAppendix) systemPromptAppendices.push(artifact.manifest.systemPromptAppendix)
    provenance.push({ id: item.packId, version: item.version, commit: item.commit, digest: item.digest, enabledSkills: [...item.enabledSkills].sort() })
  }
  return { files, pluginPaths, skillIds, provenanceJson: JSON.stringify(provenance), systemPromptAppendices }
}
