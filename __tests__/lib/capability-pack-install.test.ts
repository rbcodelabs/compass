import { expect, it, vi } from "vitest"
import { installCapabilityPack } from "@/lib/capability-pack-service"
const { fetchPack } = vi.hoisted(() => ({ fetchPack: vi.fn() }))
vi.mock("@/lib/capability-pack-github", () => ({ fetchGithubCapabilityPack: fetchPack }))

it("rejects a curated identity mismatch before any storage or metadata operation", async () => {
  fetchPack.mockResolvedValue(new Map([
    ["compass-pack.json", Buffer.from(JSON.stringify({ schemaVersion: 1, id: "impostor", displayName: "Sample", version: "1.0.0", sdkCompatibility: "0.3.224", requiredHostCapabilities: [], skills: [{ id: "sample", path: "skills/sample/SKILL.md" }] }))],
    ["skills/sample/SKILL.md", Buffer.from("---\nname: sample\ndescription: sample\n---\nInstructions")],
  ]))
  const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
  const prisma = { capabilityPack: { upsert: vi.fn() } }
  await expect(installCapabilityPack({ repositoryUrl: "https://github.com/example/skills", commitSha: "a".repeat(40), packPath: "packs/sample", workspaceId: "ws", createdById: "user", expectedPackId: "agentic-pm-compass" }, { prisma: prisma as never, storage })).rejects.toThrow(/identity/i)
  expect(storage.get).not.toHaveBeenCalled()
  expect(storage.put).not.toHaveBeenCalled()
  expect(prisma.capabilityPack.upsert).not.toHaveBeenCalled()
})

it("rejects an unsupported default asset before writing the artifact or installed metadata", async () => {
  fetchPack.mockResolvedValue(new Map([
    ["compass-pack.json", Buffer.from(JSON.stringify({ schemaVersion: 1, id: "sample", displayName: "Sample", version: "1.0.0", sdkCompatibility: "0.3.224", requiredHostCapabilities: [], skills: [{ id: "sample", path: "skills/sample/SKILL.md" }] }))],
    ["skills/sample/SKILL.md", Buffer.from("---\nname: sample\ndescription: sample\n---\n![image](image.png)")],
    ["skills/sample/image.png", Buffer.from("png")],
  ]))
  const storage = { put: vi.fn(), get: vi.fn(), del: vi.fn() }
  const prisma = { capabilityPack: { upsert: vi.fn() } }
  await expect(installCapabilityPack({ repositoryUrl: "https://github.com/example/skills", commitSha: "a".repeat(40), packPath: "packs/sample", workspaceId: "ws", createdById: "user" }, { prisma: prisma as never, storage })).rejects.toThrow(/unsupported.*asset/i)
  expect(storage.put).not.toHaveBeenCalled()
  expect(prisma.capabilityPack.upsert).not.toHaveBeenCalled()
})
