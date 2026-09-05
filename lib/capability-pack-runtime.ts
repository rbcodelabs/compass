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
export const AVAILABLE_HOST_CAPABILITIES = ["compass.product_state"] as const
const ACTIVE_PACK_LIMIT = 5
const ACTIVE_SKILL_LIMIT = 40
const ACTIVE_FILE_LIMIT = 100
const ACTIVE_BYTES_LIMIT = 5 * 1024 * 1024
const SYSTEM_APPENDIX_LIMIT = 64 * 1024

function compareVersion(left: string, right: string): number {
  const parse = (value: string) => { const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value); if (!match) throw new Error("Invalid SDK compatibility version"); return match.slice(1).map(Number) }
  const a = parse(left); const b = parse(right)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

function supportsHostSdk(range: string): boolean {
  const trimmed = range.trim()
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) return compareVersion(HOST_SDK_VERSION, trimmed) === 0
  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0 || tokens.some((token) => !/^(?:>=|<=|>|<|=)\d+\.\d+\.\d+$/.test(token))) return false
  return tokens.every((token) => {
    const match = /^(>=|<=|>|<|=)(.+)$/.exec(token)!
    const cmp = compareVersion(HOST_SDK_VERSION, match[2])
    return match[1] === ">=" ? cmp >= 0 : match[1] === "<=" ? cmp <= 0 : match[1] === ">" ? cmp > 0 : match[1] === "<" ? cmp < 0 : cmp === 0
  })
}

export function assertPackHostCompatibility(sdkCompatibility: string, requiredHostCapabilities: string[]): void {
  if (!supportsHostSdk(sdkCompatibility)) throw new Error(`Capability pack is incompatible with Agent SDK ${HOST_SDK_VERSION}`)
  const available = new Set<string>(AVAILABLE_HOST_CAPABILITIES)
  const unavailable = requiredHostCapabilities.filter((capability) => !available.has(capability))
  if (unavailable.length > 0) throw new Error(`Capability pack requires unavailable host capability: ${unavailable.join(", ")}`)
}

export async function prepareCapabilityPacksForTurn(
  active: ActiveCapabilityPack[],
  storage: Pick<ArtifactStorage, "get">
): Promise<{ files: SandboxPackFile[]; pluginPaths: string[]; skillIds: string[]; provenanceJson: string; systemPromptAppendices: string[] }> {
  if (active.length > ACTIVE_PACK_LIMIT) throw new Error(`At most ${ACTIVE_PACK_LIMIT} capability packs may be active`)
  const files: SandboxPackFile[] = []
  const pluginPaths: string[] = []
  const skillIds: string[] = []
  const systemPromptAppendices: string[] = []
  const seenSkills = new Set<string>()
  const provenance: Array<{ id: string; version: string; commit: string; digest: string; enabledSkills: string[] }> = []
  let totalBytes = 0
  let appendixBytes = 0

  for (const item of [...active].sort((a, b) => a.packId.localeCompare(b.packId))) {
    const bytes = await storage.get(item.pathname)
    if (!bytes) throw new Error(`Capability pack artifact not found: ${item.packId}@${item.version}`)
    const artifact = verifyCapabilityPackArtifact(bytes, item.digest)
    if (artifact.manifest.id !== item.packId || artifact.manifest.version !== item.version) throw new Error(`Capability pack metadata mismatch: ${item.packId}`)
    assertPackHostCompatibility(artifact.manifest.sdkCompatibility, artifact.manifest.requiredHostCapabilities)
    const declared = new Set(artifact.manifest.skills.map((skill) => skill.id))
    for (const skill of item.enabledSkills) {
      if (!declared.has(skill)) throw new Error(`Enabled skill is not declared by ${item.packId}: ${skill}`)
      if (seenSkills.has(skill)) throw new Error(`Duplicate skill id across active packs: ${skill}`)
      seenSkills.add(skill)
      skillIds.push(`${item.packId}:${skill}`)
      if (skillIds.length > ACTIVE_SKILL_LIMIT) throw new Error(`Active capability packs exceed ${ACTIVE_SKILL_LIMIT} enabled skills`)
    }
    const directory = `capability-packs/${item.packId}-${item.version}-${item.digest.slice(0, 12)}`
    pluginPaths.push(directory)
    for (const file of artifact.files) {
      const content = new Uint8Array(Buffer.from(file.contentBase64, "base64"))
      totalBytes += content.byteLength
      if (files.length >= ACTIVE_FILE_LIMIT || totalBytes > ACTIVE_BYTES_LIMIT) throw new Error("Active capability packs exceed materialization limits")
      files.push({ path: `${directory}/${file.path}`, content })
    }
    if (artifact.manifest.systemPromptAppendix) {
      appendixBytes += Buffer.byteLength(artifact.manifest.systemPromptAppendix)
      if (appendixBytes > SYSTEM_APPENDIX_LIMIT) throw new Error("Capability pack system prompt appendices exceed 64 KiB")
      systemPromptAppendices.push(artifact.manifest.systemPromptAppendix)
    }
    provenance.push({ id: item.packId, version: item.version, commit: item.commit, digest: item.digest, enabledSkills: [...item.enabledSkills].sort() })
  }
  return { files, pluginPaths, skillIds, provenanceJson: JSON.stringify(provenance), systemPromptAppendices }
}
