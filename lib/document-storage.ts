import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, open, realpath, unlink } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import getPrisma from "@/lib/db"
import { getActiveSchema } from "@/lib/schema"
import { getManagedPilotContext } from "@/lib/preview-automation/managed-context"

function isLocalPilot() {
  if (process.env.VERCEL_ENV || process.env.NODE_ENV === "production" || process.env.E2E_ISOLATED_DATABASE !== "1") return false
  try {
    const url = new URL(process.env.DATABASE_URL ?? "")
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) && url.pathname === "/compass_e2e"
  } catch { return false }
}

export function documentBlobPrefix(workspaceId: string) {
  return `geode_docs_${createHash("sha256").update(`${getActiveSchema()}:${workspaceId}`).digest("hex").slice(0, 40)}/`
}

export function isDocumentPilotWorkspace(workspaceId: string): boolean {
  const managed = getManagedPilotContext()
  if (managed && process.env.GEODE_DOCS_PILOT_WORKSPACE_ID && process.env.GEODE_DOCS_PILOT_WORKSPACE_ID !== managed.workspaceId) throw new Error("Managed pilot workspace mismatch")
  if (!process.env.GEODE_DOCS_PILOT_WORKSPACE_ID || workspaceId !== process.env.GEODE_DOCS_PILOT_WORKSPACE_ID) return false
  const schema = getActiveSchema()
  // Shared preview/prod schemas are never eligible for the synthetic pilot.
  const isolatedPreview = process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_AUTOMATION_ENABLED === "1" && /^compass_pr_\d+_[a-f0-9]{12}$/.test(schema)
  const isolatedLocal = isLocalPilot() && schema === "compass_dev"
  if (!isolatedPreview && !isolatedLocal) throw new Error("Geode document pilot requires an isolated preview or local schema")
  return true
}

export async function getDocumentStore(workspaceId: string) {
  if (!isDocumentPilotWorkspace(workspaceId)) throw new Error("Geode document storage is unavailable for this workspace")
  const managed = getManagedPilotContext()
  async function requireActiveManagedRun() {
    if (!managed) return
    const run = await getPrisma().previewAutomationRun.findUnique({ where: { id: managed.runId } })
    if (!run || run.workspaceId !== workspaceId || run.deploymentId !== managed.deploymentId || run.revokedAt || run.expiresAt <= new Date()) throw new Error("Managed pilot run unavailable")
  }
  await requireActiveManagedRun()
  if (process.env.GEODE_DOCS_LOCAL_ROOT) {
    if (!isLocalPilot() || !isAbsolute(process.env.GEODE_DOCS_LOCAL_ROOT)) throw new Error("Geode local storage requires isolated E2E configuration")
    const root = await realpath(process.env.GEODE_DOCS_LOCAL_ROOT)
    const dir = join(root, createHash("sha256").update(workspaceId).digest("hex"))
    await mkdir(dir, { recursive: true, mode: 0o700 })
    if (await realpath(dir) !== dir) throw new Error("Geode local storage refuses symbolic links")
    const pathFor = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"))
    const { createDocumentStore } = await import("@rbcodelabs/geode-headless/documents")
    return createDocumentStore({ namespace: workspaceId, maxContentBytes: 1_048_576, objects: {
      async put(key, bytes) {
        const temporary = join(dir, randomUUID())
        const file = await open(temporary, "wx", 0o600)
        try {
          try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
          try { await link(temporary, pathFor(key)) } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          }
        } finally { await unlink(temporary) }
        return key
      },
      async get(key) {
        let file
        try { file = await open(pathFor(key), constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
        try {
          if ((await file.stat()).size > 1_048_576) throw new Error("Object exceeds the pilot limit")
          return await file.readFile()
        } finally { await file.close() }
      },
    } })
  }
  const prefix = process.env.GEODE_DOCS_BLOB_PREFIX
  if (prefix !== documentBlobPrefix(workspaceId)) throw new Error("Geode document storage requires its isolated Blob prefix")
  const token = process.env.GEODE_DOCS_BLOB_TOKEN
  if (!token) throw new Error("Geode document storage is unavailable")
  const [{ createDocumentStore }, { createPrivateBlobStore }] = await Promise.all([
    import("@rbcodelabs/geode-headless/documents"),
    import("@rbcodelabs/geode-headless/catalog/cloud"),
  ])
  const objects = createPrivateBlobStore({
    prefix, token, maxObjectBytes: 1_048_576, maxReadBytes: 4_194_304,
    maxUploadedBytes: 11_534_336, maxOperations: 55, timeoutMs: 15_000,
    beforeWrite: async (pathname: string) => {
      await requireActiveManagedRun()
      await getPrisma().docStorageObject.create({ data: { id: randomUUID(), workspaceId, pathname } })
    },
  })
  return createDocumentStore({ namespace: workspaceId, objects, maxContentBytes: 1_048_576 })
}
