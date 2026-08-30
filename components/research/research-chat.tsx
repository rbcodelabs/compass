"use client"

import { useEffect, useRef, useState } from "react"
import { AlertCircleIcon, LoaderCircleIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Message = { id?: string; role: "INTERVIEWER" | "PARTICIPANT"; content: string; sequence?: number }
type StoredSession = { sessionId: string; resumeToken: string }

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

export function ResearchChat({ token }: { token: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [resumeToken, setResumeToken] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ answer: string; idempotencyKey: string } | null>(null)
  const transcriptEnd = useRef<HTMLDivElement | null>(null)
  const resumeAttempted = useRef(false)

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, busy, error])

  async function start(resume?: StoredSession) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/research/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(resume ?? {}) }),
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
    } catch {
      setError("The interview couldn’t start. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (resumeAttempted.current) return
    resumeAttempted.current = true
    const stored = readStoredSession(token)
    if (!stored) return
    const resumeTimer = window.setTimeout(() => void start(stored), 0)
    return () => window.clearTimeout(resumeTimer)
    // start is intentionally scoped to this token's initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function requestReply(request: { answer: string; idempotencyKey: string }) {
    if (!sessionId || !resumeToken) return
    setBusy(true)
    setError(null)
    setPending(request)
    try {
      const response = await fetch("/api/research/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          sessionId,
          resumeToken,
          answer: request.answer,
          idempotencyKey: request.idempotencyKey,
        }),
      })
      if (!response.ok) {
        setError(await responseError(response))
        return
      }
      const data = await response.json() as { message?: string; turn?: Message }
      if (!data.message?.trim()) {
        setError(fallbackError)
        return
      }
      const interviewer = data.turn ?? { role: "INTERVIEWER" as const, content: data.message.trim() }
      setMessages((current) => [...current, interviewer])
      setPending(null)
    } catch {
      setError("The interviewer couldn’t respond. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    if (!input.trim() || !sessionId || !resumeToken || busy || error) return
    const answer = input.trim()
    const request = { answer, idempotencyKey: crypto.randomUUID().replaceAll("-", "") }
    setMessages((current) => [...current, { role: "PARTICIPANT", content: answer }])
    setInput("")
    await requestReply(request)
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
          {busy ? "Starting…" : "Start interview"}
        </Button>
        {error && <ErrorMessage message={error} />}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div aria-live="polite" className="space-y-3">
        {messages.map((message, index) => (
          <div
            key={message.id ?? `${message.role}-${index}`}
            className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${message.role === "PARTICIPANT" ? "ml-auto bg-primary text-primary-foreground" : "border bg-surface-panel"}`}
          >
            {message.content}
          </div>
        ))}
        {busy && (
          <div className="flex w-fit items-center gap-2 rounded-xl border bg-surface-panel px-4 py-3 text-sm text-text-muted">
            <LoaderCircleIcon className="size-4 animate-spin" />
            Compass is listening…
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
          </div>
        )}
        <div ref={transcriptEnd} />
      </div>

      <div className="mt-6 flex gap-2">
        <Input
          aria-label="Your response"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void send() }}
          disabled={busy || Boolean(error)}
          maxLength={4000}
          placeholder="Type your response…"
        />
        <Button onClick={send} disabled={busy || Boolean(error) || !input.trim()}>
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
