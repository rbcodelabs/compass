"use client"

import { useEffect, useRef, useState } from "react"
import { AlertCircleIcon, LoaderCircleIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ResearchAttachmentPreview } from "@/components/research/research-attachment-preview"
import { readResearchChatStream, type ResearchChatAttachment } from "@/lib/research-chat-stream"

type Message = { id?: string; role: "INTERVIEWER" | "PARTICIPANT"; content: string; sequence?: number; attachments?: ResearchChatAttachment[] }
type StoredSession = { sessionId: string; resumeToken: string }
type UploadedAttachment = ResearchChatAttachment & { file?: File }
type PendingReply = { answer: string; idempotencyKey: string; attachmentIds: string[] }

const fallbackError = "We couldn’t confirm the interviewer’s reply. Retrying is safe and won’t duplicate your answer."

function storageKey(token: string) {
  return `compass-research-session-${token.slice(-16)}`
}

function readStoredSession(token: string): StoredSession | null {
  try {
    const value = localStorage.getItem(storageKey(token))
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<StoredSession>
    return typeof parsed.sessionId === "string" && typeof parsed.resumeToken === "string"
      ? { sessionId: parsed.sessionId, resumeToken: parsed.resumeToken }
      : null
  } catch {
    return null
  }
}

function readPendingReply(token: string, sessionId: string): PendingReply | null {
  try {
    const raw = localStorage.getItem(`${storageKey(token)}-pending`)
    if (!raw || raw.length > 6000) return null
    const stored = JSON.parse(raw) as { sessionId?: unknown; request?: Partial<PendingReply> }
    const request = stored.request
    if (stored.sessionId !== sessionId || !request || typeof request.answer !== "string" || request.answer.length > 4000 ||
        typeof request.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(request.idempotencyKey) ||
        !Array.isArray(request.attachmentIds) || request.attachmentIds.length > 3 ||
        request.attachmentIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) return null
    return { answer: request.answer, idempotencyKey: request.idempotencyKey, attachmentIds: request.attachmentIds }
  } catch { return null }
}

async function responseError(response: Response) {
  try {
    const data = await response.json() as { error?: string }
    if (data.error === "Interviewer is not configured") {
      return "This interview isn’t available yet. Please let the research team know."
    }
    if (response.status === 429) return "You’re moving quickly. Please wait a moment and try again."
  } catch {
    // Use the participant-safe fallback below.
  }
  return fallbackError
}

export function ResearchChat({ token, guided = false }: { token: string; guided?: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [resumeToken, setResumeToken] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingReply | null>(null)
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [provisional, setProvisional] = useState("")
  const [dragging, setDragging] = useState(false)
  const uploadLock = useRef(false)
  const transcriptEnd = useRef<HTMLDivElement | null>(null)
  const resumeAttempted = useRef(false)

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, busy, error, provisional])

  async function start(resume?: StoredSession) {
    resumeAttempted.current = true
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/research/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(!resume ? { modality: "CHAT" } : {}), ...(resume ?? {}) }),
      })
      if (!response.ok) {
        if (resume && response.status === 404) localStorage.removeItem(storageKey(token))
        setError("The interview couldn’t start. Please try again.")
        return
      }
      const data = await response.json() as {
        sessionId: string
        resumeToken: string
        status: string
        turns: Message[]
      }
      const stored = { sessionId: data.sessionId, resumeToken: data.resumeToken }
      if (data.status === "COMPLETED") localStorage.removeItem(storageKey(token))
      else localStorage.setItem(storageKey(token), JSON.stringify(stored))
      setSessionId(data.sessionId)
      setResumeToken(data.resumeToken)
      setMessages(data.turns)
      setComplete(data.status === "COMPLETED")
      if (data.status === "COMPLETED") localStorage.removeItem(`${storageKey(token)}-pending`)
      else {
        const interrupted = readPendingReply(token, data.sessionId)
        if (interrupted) { setPending(interrupted); setError(fallbackError) }
      }
    } catch {
      setError("The interview couldn’t start. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const resumeTimer = window.setTimeout(() => {
      if (resumeAttempted.current) return
      resumeAttempted.current = true
      const stored = readStoredSession(token)
      if (stored) void start(stored)
    }, 0)
    return () => window.clearTimeout(resumeTimer)
    // start is intentionally scoped to this token's initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function requestReply(request: { answer: string; idempotencyKey: string; attachmentIds: string[] }) {
    if (!sessionId || !resumeToken) return
    setBusy(true)
    setError(null)
    setPending(request)
    setProvisional("")
    try {
      // Retain only the unconfirmed request until a durable receipt arrives.
      // A reload retries this same key, never a fresh paid model request.
      localStorage.setItem(`${storageKey(token)}-pending`, JSON.stringify({ sessionId, request }))
      const response = await fetch("/api/research/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          token,
          sessionId,
          resumeToken,
          answer: request.answer,
          idempotencyKey: request.idempotencyKey,
          attachmentIds: request.attachmentIds,
        }),
      })
      if (!response.ok) {
        setError(await responseError(response))
        return
      }
      const data = response.headers.get("content-type")?.includes("application/x-ndjson")
        ? await readResearchChatStream(response, (text) => setProvisional((current) => current + text))
        : await response.json() as { message?: string; turn?: Message }
      if (!data.message?.trim()) {
        setError(fallbackError)
        return
      }
      const interviewer = data.turn ?? { role: "INTERVIEWER" as const, content: data.message.trim() }
      setMessages((current) => interviewer.id && current.some((turn) => turn.id === interviewer.id) ? current : [...current, interviewer])
      setPending(null)
      localStorage.removeItem(`${storageKey(token)}-pending`)
      setAttachments([])
    } catch {
      setError("The interviewer couldn’t respond. Please check your connection and try again.")
    } finally {
      setProvisional("")
      setBusy(false)
    }
  }

  async function send() {
    if ((!input.trim() && !attachments.length) || !sessionId || !resumeToken || busy || uploading || error) return
    const answer = input.trim()
    const request = { answer, idempotencyKey: crypto.randomUUID().replaceAll("-", ""), attachmentIds: attachments.map((attachment) => attachment.id) }
    setMessages((current) => [...current, { role: "PARTICIPANT", content: answer, attachments: attachments.map(({ id, originalName, mimeType, sizeBytes }) => ({ id, originalName, mimeType, sizeBytes })) }])
    setAttachments([])
    setInput("")
    await requestReply(request)
  }

  async function upload(file: File) {
    if (!sessionId || !resumeToken || uploadLock.current || busy || pending || attachments.length >= 3) return
    if (!file.size || file.size > 10 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp", "application/pdf"].includes(file.type)) {
      setError("Use a PNG, JPEG, WebP or PDF no larger than 10 MiB.")
      return
    }
    uploadLock.current = true
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.set("token", token)
      form.set("sessionId", sessionId)
      form.set("resumeToken", resumeToken)
      form.set("idempotencyKey", crypto.randomUUID().replaceAll("-", ""))
      form.set("file", file)
      const response = await fetch("/api/research/attachments", { method: "POST", body: form })
      if (!response.ok) {
        setError(response.status === 413 ? "That attachment is too large." : "The attachment couldn’t be uploaded. Please try again.")
        return
      }
      const attachment = await response.json() as UploadedAttachment
      setAttachments((current) => [...current, { ...attachment, file }])
    } catch {
      setError("The attachment couldn’t be uploaded. Please check your connection and try again.")
    } finally {
      uploadLock.current = false
      setUploading(false)
    }
  }

  async function finish() {
    if (!sessionId || !resumeToken || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/research/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, sessionId, resumeToken }),
      })
      if (!response.ok) {
        setError("Your interview couldn’t be completed. Please try again.")
        return
      }
      localStorage.removeItem(storageKey(token))
      localStorage.removeItem(`${storageKey(token)}-pending`)
      setComplete(true)
    } catch {
      setError("Your interview couldn’t be completed. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  if (complete) {
    return (
      <div className="rounded-xl border bg-surface-panel p-8 text-center">
        <h2 className="font-semibold">Thank you</h2>
        <p className="mt-2 text-sm text-text-subtle">Your responses have been shared with the research team.</p>
      </div>
    )
  }

  if (!sessionId) {
    return (
      <div className="space-y-3">
        <Button onClick={() => start()} disabled={busy}>
          {busy && <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />}
          {busy ? "Starting…" : guided ? "Start session" : "Start interview"}
        </Button>
        {error && <ErrorMessage message={error} />}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true) } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false)
        const files = event.dataTransfer.files
        if (files.length !== 1) { setError("Drop one screenshot or PDF at a time."); return }
        void upload(files[0])
      }}>
      {dragging && <p className="mb-3 rounded-lg border border-dashed bg-muted p-4 text-sm">Drop a screenshot or PDF to share it</p>}
      <div aria-live="polite" className="space-y-3">
        {messages.map((message, index) => (
          <div
            key={message.id ?? `${message.role}-${index}`}
            className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${message.role === "PARTICIPANT" ? "ml-auto bg-primary text-primary-foreground" : "border bg-surface-panel"}`}
          >
            <span className="whitespace-pre-wrap break-words">{message.content}</span>
            {message.attachments?.map((attachment) => <ResearchAttachmentPreview key={attachment.id} attachment={attachment} token={token} sessionId={sessionId} resumeToken={resumeToken!} />)}
          </div>
        ))}
        {provisional && <div className="max-w-[85%] rounded-xl border bg-surface-panel px-4 py-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{provisional}</p>
          <p className="mt-1 text-xs text-text-muted">Draft — not saved yet</p>
        </div>}
        {busy && !provisional && (
          <div className="flex w-fit items-center gap-2 rounded-xl border bg-surface-panel px-4 py-3 text-sm text-text-muted">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Compass is preparing the next question…
          </div>
        )}
        {error && (
          <div className="space-y-2">
            <ErrorMessage message={error} />
            {pending && (
              <Button onClick={() => requestReply(pending)} size="sm" type="button" variant="outline">
                Try again
              </Button>
            )}
            {!pending && <Button onClick={() => setError(null)} size="sm" type="button" variant="outline">Dismiss error</Button>}
          </div>
        )}
        <div ref={transcriptEnd} />
      </div>

      {attachments.length > 0 && <div className="mt-4 flex flex-wrap gap-2">
        {attachments.map((attachment) => <div className="flex max-w-full items-start gap-2 rounded-lg border bg-muted p-2 text-xs" key={attachment.id}>
          <ResearchAttachmentPreview attachment={attachment} token={token} sessionId={sessionId} resumeToken={resumeToken!} file={attachment.file} />
          <Button aria-label={`Remove ${attachment.originalName}`} size="icon-sm" variant="ghost" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} type="button"><XIcon className="size-3" /></Button>
        </div>)}
      </div>}
      <div className="mt-6 flex gap-2">
        <label className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border hover:bg-muted" title="Share screenshot or PDF">
          {uploading ? <LoaderCircleIcon className="size-4 animate-spin" /> : <PaperclipIcon className="size-4" />}
          <input
            accept="image/png,image/jpeg,image/webp,application/pdf"
            aria-label="Share screenshot or PDF"
            className="sr-only"
            disabled={uploading || busy || Boolean(pending) || attachments.length >= 3}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = "" }}
            type="file"
          />
        </label>
        <Textarea
          aria-label="Your response"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }}
          disabled={busy || Boolean(error)}
          maxLength={4000}
          placeholder="Type your response…"
        />
        <Button onClick={send} disabled={busy || uploading || Boolean(error) || (!input.trim() && !attachments.length)}>
          <SendIcon data-icon="inline-start" />
          Send
        </Button>
      </div>
      <Button className="mt-3 self-end" variant="ghost" onClick={finish} disabled={busy}>
        Finish interview
      </Button>
    </div>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  )
}
