import { postFileToPresignedTarget } from "@/lib/storage/browser-upload"

/**
 * Browser half of a direct-to-store upload (see `lib/storage/direct-upload.ts`).
 * Components call this instead of a storage SDK.
 */
export type DirectUploadTarget = {
  pathname: string
  /** The Blob credential issued by the server for this one upload (empty on S3). */
  clientToken: string
  access: "public" | "private"
  /** S3: the presigned POST to send the file to instead of using a Blob token. */
  upload?: { url: string; fields: Record<string, string> }
  /** S3, public store: the app-route URL the finished upload is served at. */
  url?: string
}

export type DirectUploadOptions = {
  contentType: string
  onProgress?: (percentage: number) => void
  signal?: AbortSignal
}

export async function uploadToTarget(target: DirectUploadTarget, file: Blob, options: DirectUploadOptions): Promise<{ url: string }> {
  if (target.upload) {
    if (target.access === "public" && !target.url) throw new Error("Upload target is missing its URL.")
    await postFileToPresignedTarget(target.upload, file, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { url: target.url ?? target.pathname }
  }
  const { put } = await import("@vercel/blob/client")
  const result = await put(target.pathname, file, {
    access: target.access,
    token: target.clientToken,
    contentType: options.contentType,
    ...(options.signal ? { abortSignal: options.signal } : {}),
    ...(options.onProgress ? { onUploadProgress: ({ percentage }: { percentage: number }) => options.onProgress!(percentage) } : {}),
  })
  return { url: result.url }
}
