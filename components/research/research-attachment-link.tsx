"use client"

import { useState } from "react"

// URLs must come from the authenticated member endpoint or an authorized Blob.
export function ResearchAttachmentLink({ url, originalName, mimeType }: { url: string; originalName: string; mimeType: string }) {
  const [failed, setFailed] = useState(false)
  const previewable = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType)
  return <div className="min-w-0 space-y-1">
    {previewable && !failed &&
      // Private URLs must bypass the public Next image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img alt={originalName} className="max-h-40 max-w-full rounded-lg border object-contain" onError={() => setFailed(true)} src={url} />}
    <a className="block break-all text-xs underline" download={originalName} href={url} rel="noopener noreferrer" target="_blank">{originalName}</a>
    {failed && <span className="block text-xs">Preview unavailable. Download the original file.</span>}
    {mimeType === "image/heic" && <span className="block text-xs">HEIC is preserved for researchers; its contents are not sent to the moderator. Download the original file to view it.</span>}
    {mimeType === "image/gif" && <span className="block text-xs">Chat can inspect only the first GIF frame, not its animation.</span>}
  </div>
}
