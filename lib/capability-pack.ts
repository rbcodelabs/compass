import { createHash } from "node:crypto"
import path from "node:path"
import matter from "gray-matter"

export const CAPABILITY_PACK_LIMITS = {
  packBytes: 1024 * 1024,
  fileBytes: 256 * 1024,
  skills: 20,
} as const

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/i
const ALLOWED_ASSET_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".svg", ".png", ".jpg", ".jpeg", ".webp"])
const FORBIDDEN_SEGMENTS = new Set([".mcp.json", "hooks", "commands", "agents", "scripts", ".claude", ".codex", "settings.json", "settings.local.json"])

export type CapabilityPackSkill = {
  id: string
  path: string
  enabledByDefault?: boolean
}

export type CapabilityPackManifest = {
  schemaVersion: 1
  id: string
  displayName: string
  version: string
  sdkCompatibility: string
  skills: CapabilityPackSkill[]
  requiredHostCapabilities: string[]
  systemPromptAppendix?: string
}

export type NormalizedPackFile = { path: string; contentBase64: string }
export type NormalizedCapabilityPack = {
  formatVersion: 1
  manifest: CapabilityPackManifest & { enabledSkills: string[] }
  files: NormalizedPackFile[]
}

const decoder = new TextDecoder("utf-8", { fatal: true })

function safeRelativePath(input: string): string {
  if (!input || input.includes("\\") || path.posix.isAbsolute(input)) throw new Error(`Invalid pack path: ${input}`)
  const normalized = path.posix.normalize(input)
  if (normalized === ".." || normalized.startsWith("../") || normalized !== input.replace(/^\.\//, "")) {
    throw new Error(`Invalid pack path: ${input}`)
  }
  const segments = normalized.split("/")
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error(`Forbidden pack component: ${input}`)
  }
  return normalized
}

function parseManifest(bytes: Uint8Array): CapabilityPackManifest {
  let value: unknown
  try { value = JSON.parse(decoder.decode(bytes)) } catch { throw new Error("compass-pack.json must be valid UTF-8 JSON") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capability pack manifest")
  const m = value as Record<string, unknown>
  const allowed = new Set(["schemaVersion", "id", "displayName", "version", "sdkCompatibility", "skills", "requiredHostCapabilities", "systemPromptAppendix"])
  if (Object.keys(m).some((key) => !allowed.has(key))) throw new Error("Capability pack manifest contains unsupported fields")
  if (m.schemaVersion !== 1) throw new Error("Unsupported capability pack schemaVersion")
  if (typeof m.id !== "string" || !ID.test(m.id)) throw new Error("Invalid capability pack id")
  if (typeof m.displayName !== "string" || !m.displayName.trim() || m.displayName.length > 120) throw new Error("Invalid capability pack displayName")
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) throw new Error("Invalid capability pack semantic version")
  if (typeof m.sdkCompatibility !== "string" || !m.sdkCompatibility.trim()) throw new Error("Invalid SDK compatibility range")
  if (!Array.isArray(m.skills) || m.skills.length === 0 || m.skills.length > CAPABILITY_PACK_LIMITS.skills) throw new Error("Capability pack must declare 1-20 skills")
  if (!Array.isArray(m.requiredHostCapabilities) || m.requiredHostCapabilities.some((item) => typeof item !== "string")) throw new Error("Invalid requiredHostCapabilities")
  if (m.systemPromptAppendix !== undefined && typeof m.systemPromptAppendix !== "string") throw new Error("Invalid systemPromptAppendix")
  const skills = m.skills.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid skill declaration")
    const skill = raw as Record<string, unknown>
    if (Object.keys(skill).some((key) => !["id", "path", "enabledByDefault"].includes(key))) throw new Error("Invalid skill declaration fields")
    if (typeof skill.id !== "string" || !ID.test(skill.id)) throw new Error("Invalid skill id")
    if (typeof skill.path !== "string") throw new Error("Invalid skill path")
    const skillPath = safeRelativePath(skill.path)
    if (skillPath !== `skills/${skill.id}/SKILL.md`) throw new Error(`Skill ${skill.id} must use skills/${skill.id}/SKILL.md`)
    if (skill.enabledByDefault !== undefined && typeof skill.enabledByDefault !== "boolean") throw new Error("Invalid enabledByDefault")
    return { id: skill.id, path: skillPath, enabledByDefault: skill.enabledByDefault }
  })
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) throw new Error("Duplicate skill id")
  return { schemaVersion: 1, id: m.id, displayName: m.displayName, version: m.version, sdkCompatibility: m.sdkCompatibility, skills, requiredHostCapabilities: m.requiredHostCapabilities as string[], ...(m.systemPromptAppendix ? { systemPromptAppendix: m.systemPromptAppendix } : {}) }
}

function referencedAssets(markdown: string, sourcePath: string): string[] {
  const refs: string[] = []
  const regex = /!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const match of markdown.matchAll(regex)) {
    const target = match[1]
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue
    refs.push(safeRelativePath(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decodeURIComponent(target)))))
  }
  return refs
}

function canonicalBytes(pack: NormalizedCapabilityPack): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(pack))
}

export function normalizeCapabilityPack(input: Map<string, Uint8Array>): NormalizedCapabilityPack & { bytes: Uint8Array; digest: string } {
  let total = 0
  const files = new Map<string, Uint8Array>()
  for (const [rawPath, bytes] of input) {
    const filePath = safeRelativePath(rawPath)
    if (bytes.byteLength > CAPABILITY_PACK_LIMITS.fileBytes) throw new Error(`Pack file exceeds 256 KiB: ${filePath}`)
    total += bytes.byteLength
    if (total > CAPABILITY_PACK_LIMITS.packBytes) throw new Error("Capability pack exceeds 1 MiB")
    const ext = path.posix.extname(filePath).toLowerCase()
    if (filePath !== "compass-pack.json" && !ALLOWED_ASSET_EXTENSIONS.has(ext)) throw new Error(`Pack file type is not allowed: ${filePath}`)
    if (files.has(filePath)) throw new Error(`Duplicate pack path: ${filePath}`)
    files.set(filePath, bytes)
  }
  const manifestBytes = files.get("compass-pack.json")
  if (!manifestBytes) throw new Error("Missing compass-pack.json")
  const manifest = parseManifest(manifestBytes)
  const declared = new Set(["compass-pack.json", ...manifest.skills.map((skill) => skill.path)])
  for (const skill of manifest.skills) {
    const bytes = files.get(skill.path)
    if (!bytes) throw new Error(`Missing declared skill file: ${skill.path}`)
    let markdown: string
    try { markdown = decoder.decode(bytes) } catch { throw new Error(`Skill must be UTF-8 Markdown: ${skill.path}`) }
    let frontmatter: Record<string, unknown>
    try { frontmatter = matter(markdown).data } catch { throw new Error(`Skill frontmatter is invalid: ${skill.path}`) }
    if (frontmatter.name !== skill.id) throw new Error(`Skill frontmatter name must match ${skill.id}`)
    for (const asset of referencedAssets(markdown, skill.path)) {
      if (!files.has(asset)) throw new Error(`Unresolved asset reference from ${skill.path}: ${asset}`)
      declared.add(asset)
    }
  }
  for (const filePath of files.keys()) if (!declared.has(filePath)) throw new Error(`Undeclared pack file: ${filePath}`)
  const plugin = new TextEncoder().encode(JSON.stringify({ name: manifest.id, version: manifest.version, description: manifest.displayName }))
  const normalizedFiles = [...files]
    .filter(([filePath]) => filePath !== "compass-pack.json")
    .map(([filePath, content]) => ({ path: filePath, contentBase64: Buffer.from(content).toString("base64") }))
  normalizedFiles.push({ path: ".claude-plugin/plugin.json", contentBase64: Buffer.from(plugin).toString("base64") })
  normalizedFiles.sort((a, b) => a.path.localeCompare(b.path))
  const pack: NormalizedCapabilityPack = {
    formatVersion: 1,
    manifest: { ...manifest, enabledSkills: manifest.skills.filter((skill) => skill.enabledByDefault !== false).map((skill) => skill.id) },
    files: normalizedFiles,
  }
  const bytes = canonicalBytes(pack)
  const digest = createHash("sha256").update(bytes).digest("hex")
  return { ...pack, bytes, digest }
}

export function verifyCapabilityPackArtifact(bytes: Uint8Array, expectedDigest: string): NormalizedCapabilityPack {
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== expectedDigest) throw new Error("Capability pack artifact digest mismatch")
  let parsed: unknown
  try { parsed = JSON.parse(decoder.decode(bytes)) } catch { throw new Error("Capability pack artifact is invalid") }
  if (!parsed || typeof parsed !== "object" || (parsed as { formatVersion?: unknown }).formatVersion !== 1) throw new Error("Unsupported capability pack artifact")
  return parsed as NormalizedCapabilityPack
}

export function parseGithubPackSource(repositoryUrl: string, commitSha: string, packPath: string) {
  let url: URL
  try { url = new URL(repositoryUrl) } catch { throw new Error("Repository URL must be a public GitHub URL") }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash) throw new Error("Repository URL must be a public https://github.com URL")
  const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean)
  if (parts.length !== 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(parts[1])) throw new Error("Repository URL must identify one GitHub repository")
  if (!COMMIT.test(commitSha)) throw new Error("A full 40-character commit SHA is required")
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, ""), commitSha: commitSha.toLowerCase(), packPath: safeRelativePath(packPath.replace(/\/$/, "")) }
}

export function buildAgentSdkOptions(input: { pluginPaths: string[]; skillIds: string[]; systemPrompt: string }) {
  return {
    plugins: input.pluginPaths.map((pluginPath) => ({ type: "local" as const, path: pluginPath, skipMcpDiscovery: true })),
    skills: input.skillIds,
    tools: [] as string[],
    strictMcpConfig: true,
    settingSources: [] as const,
    systemPrompt: input.systemPrompt,
  }
}
