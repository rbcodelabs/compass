import matter from "gray-matter"
import path from "node:path"
import { referencedAssets, type NormalizedCapabilityPack } from "@/lib/capability-pack"

export const COMPILED_PACK_CONTEXT_LIMIT = 64 * 1024
const TEXT_ASSETS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".svg"])

/** Compile verified pack data eagerly: tools: [] does not provide SDK Skill/Read. */
export function compileCapabilityPackInstructions(artifact: NormalizedCapabilityPack, enabledSkillIds: string[]): string {
  const files = new Map(artifact.files.map((file) => [file.path, file.contentBase64]))
  const declared = new Map(artifact.manifest.skills.map((skill) => [skill.id, skill]))
  const enabled = [...new Set(enabledSkillIds)].sort()
  const enabledPaths = new Set(enabled.map((id) => declared.get(id)?.path))
  const skillPaths = new Set(artifact.manifest.skills.map((skill) => skill.path))
  const assets = new Map<string, string>()
  function text(filePath: string): string {
    const encoded = files.get(filePath)
    if (encoded === undefined) throw new Error(`Missing compiled capability pack file: ${filePath}`)
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64")) }
    catch { throw new Error(`Capability pack asset must be valid UTF-8: ${filePath}`) }
  }
  const skills = enabled.map((id) => {
    const skill = declared.get(id)
    if (!skill) throw new Error(`Enabled skill is not declared by ${artifact.manifest.id}: ${id}`)
    const markdown = text(skill.path)
    for (const ref of referencedAssets(markdown, skill.path).sort()) {
      if (skillPaths.has(ref)) {
        if (!enabledPaths.has(ref)) throw new Error(`Enabled skill references a disabled skill: ${ref}`)
        continue // Enabled skill bodies are already compiled once below.
      }
      if (!TEXT_ASSETS.has(path.posix.extname(ref).toLowerCase())) throw new Error(`Unsupported capability pack asset in tool-less runtime: ${ref}`)
      if (!assets.has(ref)) assets.set(ref, text(ref))
    }
    return { id: `${artifact.manifest.id}:${id}`, path: skill.path, instructions: matter(markdown).content.trim() }
  })
  const compiled = JSON.stringify({
    packId: artifact.manifest.id,
    version: artifact.manifest.version,
    instructions: artifact.manifest.systemPromptAppendix ?? "",
    skills,
    assets: [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([assetPath, content]) => ({ path: assetPath, content })),
  })
  if (Buffer.byteLength(compiled) > COMPILED_PACK_CONTEXT_LIMIT) throw new Error("Compiled capability pack context exceeds 64 KiB")
  return compiled
}
