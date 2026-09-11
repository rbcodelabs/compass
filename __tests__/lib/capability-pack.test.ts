import { describe, expect, it } from "vitest"
import {
  buildAgentSdkOptions,
  normalizeCapabilityPack,
  parseGithubPackSource,
  verifyCapabilityPackArtifact,
} from "@/lib/capability-pack"

const SHA = "0123456789abcdef0123456789abcdef01234567"

function validFiles() {
  return new Map([
    ["compass-pack.json", new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      id: "agentic-pm-compass",
      displayName: "Agentic PM for Compass",
      version: "1.0.0",
      sdkCompatibility: ">=0.3.224 <0.4.0",
      skills: [{ id: "ost-workflow", path: "skills/ost-workflow/SKILL.md", enabledByDefault: true }],
      requiredHostCapabilities: ["compass.product_state"],
    }))],
    ["skills/ost-workflow/SKILL.md", new TextEncoder().encode("---\nname: ost-workflow\ndescription: Maintain an OST\n---\nUse [guide](assets/guide.md).")],
    ["skills/ost-workflow/assets/guide.md", new TextEncoder().encode("# Guide")],
  ])
}

describe("capability pack validation", () => {
  it("normalizes a valid pack deterministically and generates the plugin wrapper", () => {
    const first = normalizeCapabilityPack(validFiles())
    const second = normalizeCapabilityPack(new Map([...validFiles()].reverse()))
    expect(first.digest).toBe(second.digest)
    expect(first.bytes).toEqual(second.bytes)
    expect(first.manifest.enabledSkills).toEqual(["ost-workflow"])
    expect(first.files.map((file) => file.path)).toContain(".claude-plugin/plugin.json")
  })

  it.each([
    ["undeclared file", "README.md", "nope", /undeclared/i],
    ["plugin MCP config", ".mcp.json", "{}", /forbidden/i],
    ["plugin hook", "hooks/run.sh", "echo nope", /forbidden/i],
    ["executable source", "assets/run.js", "process.exit()", /file type/i],
    ["absolute path", "/tmp/escape.md", "nope", /path/i],
    ["path traversal", "../escape.md", "nope", /path/i],
  ])("rejects %s", (_label, path, value, error) => {
    const files = validFiles()
    files.set(path, new TextEncoder().encode(value))
    expect(() => normalizeCapabilityPack(files)).toThrow(error)
  })

  it("rejects unresolved asset references", () => {
    const files = validFiles()
    files.delete("skills/ost-workflow/assets/guide.md")
    expect(() => normalizeCapabilityPack(files)).toThrow(/unresolved/i)
  })

  it("rejects duplicate skill ids", () => {
    const files = validFiles()
    const manifest = JSON.parse(new TextDecoder().decode(files.get("compass-pack.json")))
    manifest.skills.push({ ...manifest.skills[0] })
    files.set("compass-pack.json", new TextEncoder().encode(JSON.stringify(manifest)))
    expect(() => normalizeCapabilityPack(files)).toThrow(/duplicate/i)
  })

  it("requires the skill name in parsed frontmatter, not the Markdown body", () => {
    const files = validFiles()
    files.delete("skills/ost-workflow/assets/guide.md")
    files.set("skills/ost-workflow/SKILL.md", new TextEncoder().encode("---\ndescription: no name\n---\nname: ost-workflow"))
    expect(() => normalizeCapabilityPack(files)).toThrow(/frontmatter name/i)
  })

  it("detects artifact corruption", () => {
    const artifact = normalizeCapabilityPack(validFiles())
    expect(() => verifyCapabilityPackArtifact(artifact.bytes, "0".repeat(64))).toThrow(/digest/i)
    expect(verifyCapabilityPackArtifact(artifact.bytes, artifact.digest).manifest.id).toBe("agentic-pm-compass")
  })
})

describe("pack source and SDK policy", () => {
  it("only accepts public github.com repositories pinned to a full commit", () => {
    expect(parseGithubPackSource("https://github.com/rbcodelabs/agent-pm-playbook", SHA, "packs/compass")).toEqual({
      owner: "rbcodelabs", repo: "agent-pm-playbook", commitSha: SHA, packPath: "packs/compass",
    })
    expect(() => parseGithubPackSource("http://github.com/a/b", SHA, "pack")).toThrow()
    expect(() => parseGithubPackSource("https://github.example.com/a/b", SHA, "pack")).toThrow()
    expect(() => parseGithubPackSource("https://github.com/a/b", "main", "pack")).toThrow(/commit/i)
    expect(() => parseGithubPackSource("https://github.com/a/b", SHA, "../pack")).toThrow(/path/i)
  })

  it("constructs a skills-only host-owned SDK policy", () => {
    expect(buildAgentSdkOptions({
      pluginPaths: ["/packs/a"],
      skillIds: ["a:one"],
      systemPrompt: "host context",
    })).toMatchObject({
      plugins: [{ type: "local", path: "/packs/a", skipMcpDiscovery: true }],
      skills: ["a:one"],
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      systemPrompt: "host context",
    })
  })
})
