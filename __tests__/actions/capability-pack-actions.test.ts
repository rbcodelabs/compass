import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), resolveAdmin: vi.fn(), install: vi.fn(), configure: vi.fn(), revalidate: vi.fn(),
}))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/permissions", () => ({ resolveWorkspaceAdmin: mocks.resolveAdmin }))
vi.mock("@/lib/capability-pack-service", () => ({ installCapabilityPack: mocks.install, configureWorkspaceCapabilityPack: mocks.configure }))
vi.mock("@/lib/artifact-storage", () => ({ getCapabilityPackArtifactStorage: () => ({}) }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))

import { installWorkspaceCapabilityPack, updateWorkspaceCapabilityPack } from "@/app/[orgSlug]/[workspaceSlug]/settings/capability-pack-actions"

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
