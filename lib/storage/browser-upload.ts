/**
 * Browser side of an S3 direct upload.
 *
 * S3 presigned POST wants multipart/form-data with the signed policy fields
 * first and the file LAST. XHR rather than fetch, because fetch cannot report
 * upload progress and the composer shows a per-file progress bar.
 *
 * No Compass credentials are involved: the policy in `fields` is the whole
 * authorization, and the bucket's CORS rule must allow this origin to POST.
 */
export function postFileToPresignedTarget(
  target: { url: string; fields: Record<string, string> },
  file: Blob,
  { onProgress, signal }: { onProgress?: (percentage: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData()
    for (const [name, value] of Object.entries(target.fields)) form.append(name, value)
    form.append("file", file)

    const request = new XMLHttpRequest()
    request.open("POST", target.url)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress((event.loaded / event.total) * 100)
    }
    request.onload = () => {
      // S3 answers 204 on success (or 201 with success_action_status).
      if (request.status >= 200 && request.status < 300) resolve()
      else reject(new Error(`Upload was rejected (HTTP ${request.status}).`))
    }
    request.onerror = () => reject(new Error("Upload failed. Check your connection and try again."))
    request.onabort = () => reject(new DOMException("Upload aborted", "AbortError"))
    if (signal) {
      if (signal.aborted) {
        request.abort()
        return
      }
      signal.addEventListener("abort", () => request.abort(), { once: true })
    }
    request.send(form)
  })
}
