import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), resolveAdmin: vi.fn(), install: vi.fn(), configure: vi.fn(), revalidate: vi.fn(), resolveSource: vi.fn(), findExisting: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/permissions", () => ({ resolveWorkspaceAdmin: mocks.resolveAdmin }))
vi.mock("@/lib/capability-pack-service", () => ({ installCapabilityPack: mocks.install, configureWorkspaceCapabilityPack: mocks.configure }))
vi.mock("@/lib/artifact-storage", () => ({ getCapabilityPackArtifactStorage: () => ({}) }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))
vi.mock("@/lib/capability-pack-github", () => ({ resolveAgenticPmPackSource: mocks.resolveSource }))

import { installAgenticPmCapabilityPack, installWorkspaceCapabilityPack, updateWorkspaceCapabilityPack } from "@/app/[orgSlug]/[workspaceSlug]/settings/capability-pack-actions"

describe("curated one-click installation", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.resolveAdmin.mockResolvedValue({ prisma: { workspaceCapabilityPack: { findFirst: mocks.findExisting } }, workspaceId: "ws-1" })
    mocks.findExisting.mockResolvedValue(null)
    mocks.resolveSource.mockResolvedValue({ repositoryUrl: "https://github.com/rbcodelabs/agent-pm-playbook", packPath: "packs/compass", commitSha: "a".repeat(40) })
    mocks.install.mockResolvedValue({ id: "v1", manifestJson: '{"enabledSkills":["one"]}' })
  })
  it("authorizes before any source resolution and rejects non-admin access", async () => {
    mocks.resolveAdmin.mockRejectedValue(new Error("Forbidden"))
    await expect(installAgenticPmCapabilityPack("o", "w")).rejects.toThrow("Forbidden")
    expect(mocks.resolveSource).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })
  it("performs no admin/source/storage work for an unauthenticated caller", async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(installAgenticPmCapabilityPack("o", "w")).rejects.toThrow("Unauthorized")
    expect(mocks.resolveAdmin).not.toHaveBeenCalled()
    expect(mocks.resolveSource).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })
  it("passes the resolved immutable source to validated installation and preserves race winners", async () => {
    await installAgenticPmCapabilityPack("o", "w")
    expect(mocks.resolveSource).toHaveBeenCalledTimes(1)
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ commitSha: "a".repeat(40), expectedPackId: "agentic-pm-compass", workspaceId: "ws-1" }), expect.anything())
    expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({ preserveExisting: true }), expect.anything())
  })
  it("does not fetch, update, or re-enable an existing curated attachment", async () => {
    mocks.findExisting.mockResolvedValue({ id: "existing", enabled: false, enabledSkillIds: '[]' })
    await expect(installAgenticPmCapabilityPack("o", "w")).resolves.toEqual({ installed: true })
    expect(mocks.findExisting).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "ws-1", capabilityPackVersion: expect.objectContaining({ sourceRepository: "https://github.com/rbcodelabs/agent-pm-playbook", sourcePath: "packs/compass" }) }) }))
    expect(mocks.resolveSource).not.toHaveBeenCalled()
    expect(mocks.configure).not.toHaveBeenCalled()
  })
  it("returns a safe resolution failure without mutating installation", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resolveSource.mockRejectedValue(new Error("secret-provider-payload"))
    const result = await installAgenticPmCapabilityPack("o", "w")
    expect(result).toEqual({ error: expect.stringContaining("Unable to install") })
    expect(JSON.stringify(result)).not.toContain("secret-provider-payload")
    expect(mocks.install).not.toHaveBeenCalled()
    diagnostic.mockRestore()
  })
})

describe("capability pack settings actions", () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "user-1" } }); mocks.resolveAdmin.mockResolvedValue({ prisma: {}, workspaceId: "ws-1" }); mocks.install.mockResolvedValue({ id: "v-1", manifestJson: JSON.stringify({ enabledSkills: ["one"] }) }) })
  it("requires authentication and workspace-admin authorization before installation", async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(installWorkspaceCapabilityPack("o", "w", { repositoryUrl: "x", commitSha: "x", packPath: "x" })).rejects.toThrow("Unauthorized")
    expect(mocks.install).not.toHaveBeenCalled()
  })
  it("installs and attaches the immutable version with default skills", async () => {
    await expect(installWorkspaceCapabilityPack("o", "w", { repositoryUrl: "https://github.com/o/r", commitSha: "a".repeat(40), packPath: "pack" })).resolves.toEqual({ id: "v-1" })
    expect(mocks.resolveAdmin).toHaveBeenCalledWith("o", "w")
    expect(mocks.configure).toHaveBeenCalledWith({ workspaceId: "ws-1", packVersionId: "v-1", enabledSkillIds: ["one"], enabled: true }, {})
  })
  it("uses the admin gate for upgrades, rollback, skill selection, and disable", async () => {
    await updateWorkspaceCapabilityPack("o", "w", { packVersionId: "v-2", enabledSkillIds: [], enabled: false })
    expect(mocks.resolveAdmin).toHaveBeenCalledWith("o", "w")
    expect(mocks.configure).toHaveBeenCalledWith({ workspaceId: "ws-1", packVersionId: "v-2", enabledSkillIds: [], enabled: false }, {})
  })
  it("returns an actionable source validation error without calling external storage", async () => {
    await expect(installWorkspaceCapabilityPack("o", "w", { repositoryUrl: "https://github.com/o/r", commitSha: "main", packPath: "pack" })).resolves.toEqual({ error: "A full 40-character commit SHA is required" })
    expect(mocks.install).not.toHaveBeenCalled()
  })
  it("returns a safe installation error instead of exposing external exception details", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.install.mockRejectedValue(new Error("provider failure token=secret-example"))
    const result = await installWorkspaceCapabilityPack("o", "w", { repositoryUrl: "https://github.com/o/r", commitSha: "a".repeat(40), packPath: "pack" })
    expect(result).toEqual({ error: "Unable to install this capability pack. Check the repository, commit and pack path. If they are correct, ask an administrator to check private pack storage." })
    expect(JSON.stringify(result)).not.toContain("secret-example")
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
    expect(diagnostic).toHaveBeenCalledWith("Capability pack operation failed", { operation: "install", errorName: "Error" })
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret-example")
  })
})
