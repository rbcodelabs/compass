import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), link: vi.fn(), unlink: vi.fn(), refresh: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/db", () => ({ default: () => ({ workspace: { findFirst: mocks.workspace } }) }))
vi.mock("next/cache", () => ({ revalidatePath: mocks.refresh }))
vi.mock("@/lib/artifacts", () => ({ linkArtifactToDecision: mocks.link, unlinkArtifactFromDecision: mocks.unlink }))
import * as actions from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "member" } }); mocks.workspace.mockResolvedValue({ id: "workspace" }) })
for (const name of ["linkArtifactDecision", "unlinkArtifactDecision"] as const) {
  const action = actions[name]
  it(`${name} denies unauthenticated callers before shared mutation`, async () => {
    mocks.auth.mockResolvedValue(null)
    await expect(action("workspace", "artifact", "request", "/org/ws/docs")).rejects.toThrow("Unauthorized")
    expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled()
  })
  it(`${name} denies an organization admin without workspace membership`, async () => {
    mocks.workspace.mockResolvedValue(null)
    await expect(action("workspace", "artifact", "request", "/org/ws/docs")).rejects.toThrow("Workspace not found or access denied")
    expect(mocks.workspace).toHaveBeenCalledWith({ where: { id: "workspace", members: { some: { userId: "member" } } }, select: { id: true } })
    expect(mocks.link).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled()
  })
  it(`${name} invalidates both reciprocal views only after success`, async () => {
    await action("workspace", "artifact", "request", "/org/ws/docs")
    expect(name === "linkArtifactDecision" ? mocks.link : mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace", artifactId: "artifact", requestId: "request" }))
    expect(mocks.refresh).toHaveBeenCalledWith("/org/ws/docs/artifacts/artifact")
    expect(mocks.refresh).toHaveBeenCalledWith("/org/ws/reviews/request")
  })
  it(`${name} propagates target validation failure without refreshing`, async () => {
    const mutation = name === "linkArtifactDecision" ? mocks.link : mocks.unlink
    mutation.mockRejectedValue(new Error("Artifact not found"))
    await expect(action("workspace", "foreign-artifact", "request", "/org/ws/docs")).rejects.toThrow("Artifact not found")
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
}
