import { createReadStream } from "node:fs"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import path from "node:path"
import type { ArtifactStorage } from "@/lib/storage/types"

const LOCAL_ROOT = path.join("/tmp", "compass-artifacts")

function localPath(pathname: string): string {
  const normalized = path.posix.normalize(pathname).replace(/^\/+/, "")
  if (normalized.startsWith("..")) throw new Error("Invalid artifact storage path")
  return path.join(LOCAL_ROOT, normalized)
}

/** Local disk, for development and self-hosted/E2E runs only (see lib/artifact-storage.ts). */
export const localStorage: ArtifactStorage = {
  async put(pathname, bytes, _contentType, options) {
    const target = localPath(pathname)
    await mkdir(path.dirname(target), { recursive: true })
    if (options?.overwrite === false) {
      try {
        await writeFile(target, bytes, { flag: "wx" })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { pathname, created: false }
        throw error
      }
      return { pathname, created: true }
    }
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
  async getStream(pathname) {
    const target = localPath(pathname)
    try {
      const info = await stat(target)
      if (!info.isFile()) return null
      return { stream: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>, size: info.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  },
  async del(pathname) {
    await rm(localPath(pathname), { force: true })
  },
}
