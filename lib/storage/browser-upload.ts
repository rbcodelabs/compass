import type { PresignedUploadTarget } from "@/lib/storage/direct-upload-client"

/** XHR preserves the composer's upload progress while the browser streams the raw file. */
export function putFileToPresignedTarget(
  target: PresignedUploadTarget,
  file: Blob,
  { onProgress, signal }: { onProgress?: (percentage: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const abortError = () => new DOMException("Upload aborted", "AbortError")
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    const finish = (error?: Error) => {
      signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve()
    }
    request.open(target.method, target.url)
    for (const [name, value] of Object.entries(target.headers)) request.setRequestHeader(name, value)
    if (onProgress) {
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress((event.loaded / event.total) * 100)
      }
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) finish()
      else finish(new Error(`Upload was rejected (HTTP ${request.status}).`))
    }
    request.onerror = () => finish(new Error("Upload failed. Check your connection and try again."))
    request.onabort = () => finish(abortError())
    signal?.addEventListener("abort", abort, { once: true })
    try {
      request.send(file)
    } catch (error) {
      signal?.removeEventListener("abort", abort)
      reject(error)
    }
  })
}
