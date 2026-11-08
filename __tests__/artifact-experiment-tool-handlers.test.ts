import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ link: vi.fn(), unlink: vi.fn(), actor: vi.fn() }))
vi.mock("@/lib/artifacts", () => ({ linkArtifactToExperiment: mocks.link, unlinkArtifactFromExperiment: mocks.unlink }))
vi.mock("@/lib/mcp-authz", () => ({ getMcpActor: () => mocks.actor() }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
import { linkArtifactExperiment, unlinkArtifactExperiment } from "@/lib/artifact-tool-handlers"

const input = { workspaceId: "workspace", artifactId: "artifact", experimentId: "experiment" }
beforeEach(() => { vi.resetAllMocks(); mocks.actor.mockReturnValue({ userId: "owner", purpose: "USER" }) })

it("link_artifact_to_experiment attributes the person, prints the ID on its own line and returns stable identifiers", async () => {
  mocks.link.mockResolvedValue({ id: "link-1", created: true })
  const result = await linkArtifactExperiment(input)
  expect(mocks.link).toHaveBeenCalledWith({ ...input, createdById: "owner", source: "MCP" })
  expect(result.content[0].text.split("\n")).toContain("ID: artifact")
  expect(result.structuredContent.data).toEqual({ ...input, linkId: "link-1", created: true })
})

it("link_artifact_to_experiment records no person for an agent identity", async () => {
  mocks.actor.mockReturnValue({ userId: "owner", purpose: "AGENT", agentId: "agent-1" })
  mocks.link.mockResolvedValue({ id: "link-1", created: false })
  await linkArtifactExperiment(input)
  expect(mocks.link).toHaveBeenCalledWith({ ...input, createdById: null, source: "MCP" })
})

it("reports a refusal (foreign, archived, missing) as a tool failure instead of throwing", async () => {
  mocks.link.mockRejectedValue(new Error("Archived artifacts cannot be linked to an experiment."))
  const result = await linkArtifactExperiment(input)
  expect(result.structuredContent.ok).toBe(false)
  expect(result.content[0].text).toMatch(/Archived artifacts/)
})

it("unlink_artifact_from_experiment is idempotent and prints the ID line", async () => {
  mocks.unlink.mockResolvedValue({ removed: false })
  const result = await unlinkArtifactExperiment(input)
  expect(mocks.unlink).toHaveBeenCalledWith(input)
  expect(result.content[0].text.split("\n")).toContain("ID: artifact")
  expect(result.structuredContent.data).toEqual({ ...input, removed: false })
  mocks.unlink.mockRejectedValue(new Error("Artifact not found in this workspace."))
  expect((await unlinkArtifactExperiment(input)).structuredContent.ok).toBe(false)
})
