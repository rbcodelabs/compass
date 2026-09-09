import { del, get, put } from "@vercel/blob"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface ArtifactStorage {
  put(pathname: string, bytes: Uint8Array, contentType?: string): Promise<{ pathname: string }>
  get(pathname: string): Promise<Uint8Array | null>
  del(pathname: string): Promise<void>
}

const LOCAL_ROOT = path.join("/tmp", "compass-artifacts")

function localPath(pathname: string): string {
  const normalized = path.posix.normalize(pathname).replace(/^\/+/, "")
  if (normalized.startsWith("..")) throw new Error("Invalid artifact storage path")
  return path.join(LOCAL_ROOT, normalized)
}

const localStorage: ArtifactStorage = {
  async put(pathname, bytes) {
    const target = localPath(pathname)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
    return { pathname }
  },
  async get(pathname) {
    try {
      return new Uint8Array(await readFile(localPath(pathname)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  },
  async del(pathname) {
    await rm(localPath(pathname), { force: true })
  },
}

function createVercelBlobStorage(token: string | (() => string)): ArtifactStorage {
  const tokenOptions = () => ({ token: typeof token === "function" ? token() : token })
  return {
    async put(pathname, bytes, contentType = "text/html; charset=utf-8") {
      const result = await put(pathname, Buffer.from(bytes), {
        access: "private",
        contentType,
        addRandomSuffix: false,
        ...tokenOptions(),
      })
      return { pathname: result.pathname }
    },
    async get(pathname) {
      const result = await get(pathname, { access: "private", useCache: false, ...tokenOptions() })
      if (!result || result.statusCode !== 200) return null
      return new Uint8Array(await new Response(result.stream).arrayBuffer())
    },
    async del(pathname) {
      await del(pathname, tokenOptions())
    },
  }
}

/** Local development uses private filesystem storage; deployed environments
 * use authenticated private Vercel Blob. The interface is injected in tests. */
export function getArtifactStorage(): ArtifactStorage {
  if (process.env.DATABASE_URL) return localStorage
  // Resolve only for actual I/O, so deleting a workspace without HTML artifacts
  // does not require Blob configuration. Never inherit the public image token.
  return createVercelBlobStorage(() => {
    const token = process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN?.trim()
    if (!token) throw new Error("Private artifact storage is not configured")
    return token
  })
}

/** Packs must never inherit the project's general (potentially public) store. */
export function getCapabilityPackArtifactStorage(): ArtifactStorage {
  if (process.env.DATABASE_URL) return localStorage
  const token = process.env.CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Private capability pack storage is not configured")
  // @vercel/blob 2.4.1 prioritizes explicit token over ambient OIDC/store IDs.
  return createVercelBlobStorage(token)
}

export function getResearchArtifactStorage(): ArtifactStorage {
  if (process.env.DATABASE_URL) return localStorage
  const token = process.env.RESEARCH_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Research Blob storage is not configured")
  return createVercelBlobStorage(token)
}
