import { afterEach, describe, expect, it, vi } from "vitest"
import { getDocumentStore, isDocumentPilotWorkspace } from "@/lib/document-storage"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

afterEach(() => vi.unstubAllEnvs())
describe("pilot storage environment gate", () => {
  it("does not enable any workspace by default", () => {
    vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "")
    expect(isDocumentPilotWorkspace("any")).toBe(false)
  })
  it("rejects shared preview even when a workspace is configured", () => {
    vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace-a")
    vi.stubEnv("VERCEL_ENV", "preview")
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "")
    vi.stubEnv("PGSCHEMA", "compass")
    expect(() => isDocumentPilotWorkspace("workspace-a")).toThrow("isolated")
  })
  it("rejects production even with an isolated-looking schema prefix", () => {
    vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace-a")
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("PGSCHEMA", "compass")
    vi.stubEnv("E2E_ISOLATED_DATABASE", "1")
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5437/compass_e2e")
    expect(() => isDocumentPilotWorkspace("workspace-a")).toThrow("isolated")
  })
  it("allows an isolated local schema only for its configured workspace", () => {
    vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace-a")
    vi.stubEnv("VERCEL_ENV", "")
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "")
    vi.stubEnv("PGSCHEMA", "compass")
    vi.stubEnv("E2E_ISOLATED_DATABASE", "1")
    vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5437/compass_e2e")
    expect(isDocumentPilotWorkspace("workspace-a")).toBe(true)
    expect(isDocumentPilotWorkspace("workspace-b")).toBe(false)
  })
  it("persists SDK bytes across independent local store instances under E2E guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "geode-docs-test-"))
    try {
      vi.stubEnv("GEODE_DOCS_PILOT_WORKSPACE_ID", "workspace-a")
      vi.stubEnv("VERCEL_ENV", "")
      vi.stubEnv("NODE_ENV", "test")
      vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "")
      vi.stubEnv("PGSCHEMA", "compass")
      vi.stubEnv("E2E_ISOLATED_DATABASE", "1")
      vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5437/compass_e2e")
      vi.stubEnv("GEODE_DOCS_LOCAL_ROOT", root)
      const first = await getDocumentStore("workspace-a")
      const written = await first.putContent("\uFEFF  Unicode 日本語\n")
      expect(written.status).toBe("ok")
      if (written.status !== "ok") throw new Error(written.status)
      const second = await getDocumentStore("workspace-a")
      expect(await second.readContent(written.reference)).toEqual({ status: "ok", text: "\uFEFF  Unicode 日本語\n" })
      vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5437/compass")
      await expect(getDocumentStore("workspace-a")).rejects.toThrow("isolated")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
