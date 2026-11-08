/**
 * Browser half of a direct-to-store upload (see `lib/storage/direct-upload.ts`).
 * Components call this instead of `@vercel/blob/client`.
 */
export type DirectUploadTarget = {
  pathname: string
  /** The credential issued by the server for this one upload. */
  clientToken: string
  access: "public" | "private"
}

export type DirectUploadOptions = {
  contentType: string
  onProgress?: (percentage: number) => void
  signal?: AbortSignal
}

export async function uploadToTarget(target: DirectUploadTarget, file: Blob, options: DirectUploadOptions): Promise<{ url: string }> {
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
