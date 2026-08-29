import { del, get, put } from "@vercel/blob"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface ArtifactStorage {
  put(pathname: string, bytes: Uint8Array): Promise<{ pathname: string }>
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

const vercelBlobStorage: ArtifactStorage = {
  async put(pathname, bytes) {
    const result = await put(pathname, Buffer.from(bytes), {
      access: "private",
      contentType: "text/html; charset=utf-8",
      addRandomSuffix: false,
    })
    return { pathname: result.pathname }
  },
  async get(pathname) {
    const result = await get(pathname, { access: "private", useCache: false })
    if (!result || result.statusCode !== 200) return null
    return new Uint8Array(await new Response(result.stream).arrayBuffer())
  },
  async del(pathname) {
    await del(pathname)
  },
}

/** Local development uses private filesystem storage; deployed environments
 * use authenticated private Vercel Blob. The interface is injected in tests. */
export function getArtifactStorage(): ArtifactStorage {
  return process.env.DATABASE_URL ? localStorage : vercelBlobStorage
}
