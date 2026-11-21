import { hostname } from "node:os"
import { del, get, put } from "@vercel/blob"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface ArtifactStorage {
  /**
   * With `{ overwrite: false }` an existing object is left untouched and `created: false` is returned, so a caller
   * can tell which objects it created itself (and so may later delete). `created` is only reported in that mode.
   */
  put(
    pathname: string,
    bytes: Uint8Array,
    contentType?: string,
    options?: { overwrite?: boolean },
  ): Promise<{ pathname: string; created?: boolean }>
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
  async del(pathname) {
    await rm(localPath(pathname), { force: true })
  },
}

function createVercelBlobStorage(token: string | (() => string)): ArtifactStorage {
  const tokenOptions = () => ({ token: typeof token === "function" ? token() : token })
  return {
    async put(pathname, bytes, contentType = "text/html; charset=utf-8", options) {
      const noOverwrite = options?.overwrite === false
      try {
        const result = await put(pathname, Buffer.from(bytes), {
          access: "private",
          contentType,
          addRandomSuffix: false,
          ...(noOverwrite ? { allowOverwrite: false } : {}),
          ...tokenOptions(),
        })
        return noOverwrite ? { pathname: result.pathname, created: true } : { pathname: result.pathname }
      } catch (error) {
        if (noOverwrite && /already exists/i.test((error as Error | null)?.message ?? "")) return { pathname, created: false }
        throw error
      }
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

/**
 * Local disk storage is for development and self-hosted/E2E runs only. A Vercel
 * deployment (VERCEL is set) must always use Blob: its /tmp is per-instance and
 * ephemeral, and production on plain Postgres also sets DATABASE_URL, so that
 * variable alone cannot mean "local dev".
 */
export function shouldUseLocalStorage(): boolean {
  return Boolean(process.env.DATABASE_URL) && !process.env.VERCEL
}

/** Local development uses private filesystem storage; deployed environments
 * use authenticated private Vercel Blob. The interface is injected in tests. */
function rawArtifactStorage(): ArtifactStorage {
  if (shouldUseLocalStorage()) return localStorage
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
  if (shouldUseLocalStorage()) return localStorage
  const token = process.env.CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Private capability pack storage is not configured")
  // @vercel/blob 2.4.1 prioritizes explicit token over ambient OIDC/store IDs.
  return createVercelBlobStorage(token)
}

function rawResearchStorage(): ArtifactStorage {
  if (shouldUseLocalStorage()) return localStorage
  const token = process.env.RESEARCH_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Research Blob storage is not configured")
  return createVercelBlobStorage(token)
}

/**
 * Agent SDK session transcripts (one private object per conversation revision).
 * Its own store and token: a transcript holds tool results from a user's workspace,
 * so it must never share a store (or a token's blast radius) with public assets.
 */
export function getAgentSessionStorage(): ArtifactStorage {
  if (shouldUseLocalStorage()) return localStorage
  const token = process.env.AGENT_SESSION_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Agent session storage is not configured")
  return createVercelBlobStorage(token)
}

/** Whether a session transcript can be stored at all on this deployment. */
export function agentSessionStorageConfigured(): boolean {
  return Boolean(shouldUseLocalStorage() || process.env.AGENT_SESSION_BLOB_READ_WRITE_TOKEN?.trim())
}


export function privateProviderIdentity(store: "artifact" | "research") {
  if (shouldUseLocalStorage()) return { provider: "disk", namespace: hostname() + ":" + LOCAL_ROOT }
  const token = store === "artifact" ? process.env.ARTIFACT_BLOB_READ_WRITE_TOKEN : process.env.RESEARCH_BLOB_READ_WRITE_TOKEN
  const id = token?.trim().match(/^vercel_blob_rw_([a-zA-Z0-9-]+)_/i)?.[1]
  if (!id) throw new Error("Private provider namespace is unavailable")
  return { provider: "blob", namespace: id.toLowerCase() }
}

function mappedStorage(provider: ArtifactStorage, store: "artifact" | "research"): ArtifactStorage {
  async function resolve(path: string) {
    const [root, workspaceId] = path.split("/")
    if (!(store === "research" ? root === "research" : root === "docs" || root === "artifacts")) return path
    if (!workspaceId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId)) return path
    const [{ default: getPrisma }, { lookupImportAsset }] = await Promise.all([
      import("@/lib/db"), import("@/lib/workspace-export/asset-journal"),
    ])
    return await lookupImportAsset(getPrisma(), workspaceId, store, path, () => privateProviderIdentity(store)) ?? path
  }
  return {
    async put(path, bytes, contentType, options) {
      if (await resolve(path) !== path) {
        if (options?.overwrite === false) return { pathname: path, created: false }
        throw new Error("Cannot overwrite a published import asset")
      }
      return provider.put(path, bytes, contentType, options)
    },
    async get(path) { return provider.get(await resolve(path)) },
    async del(path) { await provider.del(await resolve(path)) },
  }
}

export function getArtifactStorage(): ArtifactStorage {
  return mappedStorage(rawArtifactStorage(), "artifact")
}

export function getResearchArtifactStorage(): ArtifactStorage {
  return mappedStorage(rawResearchStorage(), "research")
}
