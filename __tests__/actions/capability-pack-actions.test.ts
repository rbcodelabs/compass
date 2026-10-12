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

import { checkAgenticPmPackUpdate, installAgenticPmCapabilityPack, installWorkspaceCapabilityPack, updateAgenticPmCapabilityPack, updateWorkspaceCapabilityPack } from "@/app/[orgSlug]/[workspaceSlug]/settings/capability-pack-actions"

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

describe("Agentic PM pack update", () => {
  const OLD = "a".repeat(40), NEW = "b".repeat(40)
  const attachment = (over: Record<string, unknown> = {}) => ({
    enabled: true, enabledSkillIds: JSON.stringify(["keep"]),
    capabilityPackVersion: { sourceCommit: OLD, manifestJson: JSON.stringify({ skills: [{ id: "keep" }, { id: "off" }] }) },
    ...over,
  })
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.resolveAdmin.mockResolvedValue({ prisma: { workspaceCapabilityPack: { findFirst: mocks.findExisting } }, workspaceId: "ws-1" })
    mocks.findExisting.mockResolvedValue(attachment())
    mocks.resolveSource.mockResolvedValue({ repositoryUrl: "https://github.com/rbcodelabs/agent-pm-playbook", packPath: "packs/compass", commitSha: NEW })
    mocks.install.mockResolvedValue({ id: "v2", manifestJson: JSON.stringify({ skills: [{ id: "keep" }, { id: "off" }, { id: "fresh" }] }) })
  })

  it("check requires workspace admin before touching GitHub", async () => {
    mocks.resolveAdmin.mockRejectedValue(new Error("Forbidden"))
    await expect(checkAgenticPmPackUpdate("o", "w")).rejects.toThrow("Forbidden")
    expect(mocks.resolveSource).not.toHaveBeenCalled()
  })
  it("check reports an available update without installing anything", async () => {
    await expect(checkAgenticPmPackUpdate("o", "w")).resolves.toEqual({ installedCommit: OLD, latestCommit: NEW, updateAvailable: true })
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.configure).not.toHaveBeenCalled()
  })
  it("check reports up to date when the commits match", async () => {
    mocks.resolveSource.mockResolvedValue({ commitSha: OLD })
    await expect(checkAgenticPmPackUpdate("o", "w")).resolves.toMatchObject({ updateAvailable: false })
  })
  it("check returns a safe error when GitHub fails", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.resolveSource.mockRejectedValue(new Error("secret-provider-payload"))
    const result = await checkAgenticPmPackUpdate("o", "w")
    expect(result).toEqual({ error: expect.stringContaining("Unable to check") })
    expect(JSON.stringify(result)).not.toContain("secret-provider-payload")
    diagnostic.mockRestore()
  })
  it("check errors when the pack is not installed", async () => {
    mocks.findExisting.mockResolvedValue(null)
    await expect(checkAgenticPmPackUpdate("o", "w")).resolves.toEqual({ error: expect.stringContaining("not installed") })
    expect(mocks.resolveSource).not.toHaveBeenCalled()
  })

  it("update requires authentication and admin before any work", async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(updateAgenticPmCapabilityPack("o", "w")).rejects.toThrow("Unauthorized")
    mocks.auth.mockResolvedValue({ user: { id: "user-1" } })
    mocks.resolveAdmin.mockRejectedValue(new Error("Forbidden"))
    await expect(updateAgenticPmCapabilityPack("o", "w")).rejects.toThrow("Forbidden")
    expect(mocks.resolveSource).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })
  it("installs the latest commit, selects it, and carries over enabled state and skill choices", async () => {
    await expect(updateAgenticPmCapabilityPack("o", "w")).resolves.toEqual({ updated: true, commit: NEW })
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ commitSha: NEW, workspaceId: "ws-1", expectedPackId: "agentic-pm-compass" }), expect.anything())
    // keep: chosen before -> stays. off: declined before -> stays off. fresh: new -> default on.
    expect(mocks.configure).toHaveBeenCalledWith({ workspaceId: "ws-1", packVersionId: "v2", enabledSkillIds: ["fresh", "keep"], enabled: true }, expect.anything())
    expect(mocks.revalidate).toHaveBeenCalledWith("/o/w/settings")
  })
  it("does not re-enable a pack the admin disabled", async () => {
    mocks.findExisting.mockResolvedValue(attachment({ enabled: false }))
    await updateAgenticPmCapabilityPack("o", "w")
    expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }), expect.anything())
  })
  it("is a no-op when already on the latest commit", async () => {
    mocks.resolveSource.mockResolvedValue({ commitSha: OLD })
    await expect(updateAgenticPmCapabilityPack("o", "w")).resolves.toEqual({ updated: false, commit: OLD })
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.configure).not.toHaveBeenCalled()
  })
  it("leaves the selected version untouched and hides provider details when installation fails", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.install.mockRejectedValue(new Error("provider failure token=secret-example"))
    const result = await updateAgenticPmCapabilityPack("o", "w")
    expect(result).toEqual({ error: expect.stringContaining("installed version is unchanged") })
    expect(JSON.stringify(result)).not.toContain("secret-example")
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
    diagnostic.mockRestore()
  })
  it("refuses to update a pack that was never installed", async () => {
    mocks.findExisting.mockResolvedValue(null)
    await expect(updateAgenticPmCapabilityPack("o", "w")).resolves.toEqual({ error: expect.stringContaining("Install") })
    expect(mocks.resolveSource).not.toHaveBeenCalled()
  })
})
