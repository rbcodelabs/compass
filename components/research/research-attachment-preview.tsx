"use client"

import { useEffect, useState } from "react"
import type { ResearchChatAttachment } from "@/lib/research-chat-stream"
import { ResearchAttachmentLink } from "@/components/research/research-attachment-link"

export function ResearchAttachmentPreview({ attachment, token, sessionId, resumeToken, file }: {
  attachment: ResearchChatAttachment
  token: string
  sessionId: string
  resumeToken: string
  file?: File
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    let objectUrl: string | null = null
    async function load() {
      try {
        let blob: Blob = file ?? new Blob()
        if (!file) {
          const response = await fetch(`/api/research/attachments/${encodeURIComponent(attachment.id)}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, sessionId, resumeToken }), signal: abort.signal,
          })
          if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== attachment.mimeType || !response.body) throw new Error("Preview unavailable")
          const reader = response.body.getReader()
          const chunks: Uint8Array<ArrayBuffer>[] = []
          let size = 0
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.byteLength
              if (size > Math.min(attachment.sizeBytes, 10 * 1024 * 1024)) throw new Error("Preview too large")
              chunks.push(new Uint8Array(chunk.value))
            }
            if (size !== attachment.sizeBytes) throw new Error("Preview incomplete")
            blob = new Blob(chunks, { type: attachment.mimeType })
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
        }
        if (abort.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      } catch { if (!abort.signal.aborted) setFailed(true) }
    }
    void load()
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachment.id, attachment.mimeType, attachment.sizeBytes, token, sessionId, resumeToken, file])

  return <div className="min-w-0 space-y-1">
    {url ? <ResearchAttachmentLink key={`${attachment.id}:${url}`} url={url} originalName={attachment.originalName} mimeType={attachment.mimeType} />
      : <span className="block break-all text-xs">{attachment.originalName}</span>}
    {failed && <span className="block text-xs">Preview unavailable</span>}
  </div>
}
