/**
 * Storage backend selection. One place decides where bytes go.
 *
 * `COMPASS_STORAGE_BACKEND` is the explicit switch (`blob` | `s3` | `local`).
 * When it is unset, behavior is exactly what it was before this setting existed:
 * local disk when `DATABASE_URL` is set and the process is not on Vercel, and
 * Vercel Blob otherwise (which fails loudly when its tokens are missing).
 *
 * Nothing here silently falls back. An unknown value, `s3` without a bucket, or
 * `local` on Vercel all throw at first use.
 */

export type StorageBackend = "blob" | "s3" | "local"

type Env = Record<string, string | undefined>

export function resolveStorageBackend(env: Env = process.env): StorageBackend {
  const raw = env.COMPASS_STORAGE_BACKEND?.trim().toLowerCase()
  if (raw) {
    if (raw === "s3" || raw === "blob") return raw
    if (raw === "local") {
      if (env.VERCEL) throw new Error("COMPASS_STORAGE_BACKEND=local is not allowed on Vercel: its disk is per-instance and ephemeral")
      if (!env.DATABASE_URL) throw new Error("COMPASS_STORAGE_BACKEND=local requires DATABASE_URL")
      return "local"
    }
    throw new Error(`COMPASS_STORAGE_BACKEND must be "blob", "s3" or "local" (got "${raw}")`)
  }
  return legacyLocalStorageEnabled(env) ? "local" : "blob"
}

/** The pre-existing rule, unchanged: disk only off Vercel and with DATABASE_URL (plain Postgres). */
function legacyLocalStorageEnabled(env: Env): boolean {
  return Boolean(env.DATABASE_URL) && !env.VERCEL
}

export type S3Config = {
  bucket: string
  region: string | undefined
  forcePathStyle: boolean
}

/**
 * S3 settings. The bucket is mandatory; the region falls through to the standard
 * AWS chain (`AWS_REGION`, shared config) rather than inventing a default.
 * Credentials are never read here: the SDK's default provider chain supplies
 * them (environment, shared config, or an instance/task role).
 *
 * `AWS_ENDPOINT_URL_S3` (read by the SDK itself) plus
 * `COMPASS_S3_FORCE_PATH_STYLE=1` point the client at an S3-compatible server
 * such as MinIO. They exist for local verification and are off unless set.
 */
export function s3Config(env: Env = process.env): S3Config {
  const bucket = env.COMPASS_S3_BUCKET?.trim()
  if (!bucket) {
    throw new Error("S3 storage is not configured: COMPASS_STORAGE_BACKEND=s3 requires COMPASS_S3_BUCKET")
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("COMPASS_S3_BUCKET is not a valid S3 bucket name")
  }
  return {
    bucket,
    region: env.COMPASS_S3_REGION?.trim() || env.AWS_REGION?.trim() || undefined,
    forcePathStyle: env.COMPASS_S3_FORCE_PATH_STYLE?.trim() === "1",
  }
}
