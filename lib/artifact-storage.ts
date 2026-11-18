import { createVercelBlobStorage } from "@/lib/storage/blob-storage"
import { resolveStorageBackend } from "@/lib/storage/config"
import { localStorage } from "@/lib/storage/local-storage"
import { createS3Storage } from "@/lib/storage/s3"
import type { ArtifactStorage } from "@/lib/storage/types"

export type { ArtifactStorage }

/**
 * Backend selection lives in `lib/storage/config.ts` (`COMPASS_STORAGE_BACKEND`:
 * `blob` | `s3` | `local`).
 *
 * With `COMPASS_STORAGE_BACKEND` unset, the rule is exactly what it was before
 * that setting existed. Local disk storage is for development and
 * self-hosted/E2E runs only. A Vercel deployment (VERCEL is set) must always use
 * Blob: its /tmp is per-instance and ephemeral, and production on plain Postgres
 * also sets DATABASE_URL, so that variable alone cannot mean "local dev".
 */
export function shouldUseLocalStorage(): boolean {
  try {
    return resolveStorageBackend() === "local"
  } catch {
    // An invalid COMPASS_STORAGE_BACKEND throws from the getters below; this
    // predicate stays a plain boolean for callers that only probe.
    return false
  }
}

/** Local development uses private filesystem storage; deployed environments
 * use authenticated private Vercel Blob, or private S3 when selected. The
 * interface is injected in tests. */
export function getArtifactStorage(): ArtifactStorage {
  const backend = resolveStorageBackend()
  if (backend === "local") return localStorage
  if (backend === "s3") return createS3Storage("artifacts")
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
  const backend = resolveStorageBackend()
  if (backend === "local") return localStorage
  if (backend === "s3") return createS3Storage("capability-packs")
  const token = process.env.CAPABILITY_PACK_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Private capability pack storage is not configured")
  // @vercel/blob 2.4.1 prioritizes explicit token over ambient OIDC/store IDs.
  return createVercelBlobStorage(token)
}

export function getResearchArtifactStorage(): ArtifactStorage {
  const backend = resolveStorageBackend()
  if (backend === "local") return localStorage
  if (backend === "s3") return createS3Storage("research")
  const token = process.env.RESEARCH_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Research Blob storage is not configured")
  return createVercelBlobStorage(token)
}

/**
 * Agent SDK session transcripts (one private object per conversation revision).
 * Its own store and token: a transcript holds tool results from a user's workspace,
 * so it must never share a store (or a token's blast radius) with public assets.
 * On S3 it is its own prefix (`agent-sessions/`) in the same private bucket.
 */
export function getAgentSessionStorage(): ArtifactStorage {
  const backend = resolveStorageBackend()
  if (backend === "local") return localStorage
  if (backend === "s3") return createS3Storage("agent-sessions")
  const token = process.env.AGENT_SESSION_BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new Error("Agent session storage is not configured")
  return createVercelBlobStorage(token)
}

/** Whether a session transcript can be stored at all on this deployment. */
export function agentSessionStorageConfigured(): boolean {
  try {
    const backend = resolveStorageBackend()
    if (backend === "local") return true
    if (backend === "s3") return Boolean(process.env.COMPASS_S3_BUCKET?.trim())
  } catch {
    return false
  }
  return Boolean(process.env.AGENT_SESSION_BLOB_READ_WRITE_TOKEN?.trim())
}
