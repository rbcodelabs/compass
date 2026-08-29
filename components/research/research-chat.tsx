"use client"

import { useEffect, useRef, useState } from "react"
import { AlertCircleIcon, LoaderCircleIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Message = { role: "INTERVIEWER" | "PARTICIPANT"; content: string }

const fallbackError = "The interviewer couldn’t respond. Your answer is still here—please try again."

async function responseError(response: Response) {
  try {
    const data = await response.json() as { error?: string }
    if (data.error === "Interviewer is not configured") {
      return "This interview isn’t available yet. Please let the research team know."
    }
  } catch {
    // Use the participant-safe fallback below.
  }
  return fallbackError
}

export function ResearchChat({ token }: { token: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startedAt = useRef<number | null>(null)
  const transcriptEnd = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, busy, error])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/research/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      if (!response.ok) {
        setError("The interview couldn’t start. Please try again.")
        return
      }
      const data = await response.json() as { sessionId: string; message: string }
      startedAt.current = Date.now()
      setSessionId(data.sessionId)
      setMessages([{ role: "INTERVIEWER", content: data.message }])
    } catch {
      setError("The interview couldn’t start. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  async function requestReply(transcript: Message[]) {
    if (!sessionId) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/research/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          sessionId,
          messages: transcript,
          elapsedSeconds: startedAt.current
            ? Math.round((Date.now() - startedAt.current) / 1000)
            : undefined,
        }),
      })
      if (!response.ok) {
        setError(await responseError(response))
        return
      }
      const data = await response.json() as { message?: string }
      if (!data.message?.trim()) {
        setError(fallbackError)
        return
      }
      setMessages([...transcript, { role: "INTERVIEWER", content: data.message.trim() }])
    } catch {
      setError("The interviewer couldn’t respond. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    if (!input.trim() || !sessionId || busy || error) return
    const next = [...messages, { role: "PARTICIPANT" as const, content: input.trim() }]
    setMessages(next)
    setInput("")
    await requestReply(next)
  }

  async function finish() {
    if (!sessionId || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/research/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, sessionId, messages }),
      })
      if (!response.ok) {
        setError("Your interview couldn’t be saved. Please try again.")
        return
      }
      setComplete(true)
    } catch {
      setError("Your interview couldn’t be saved. Please check your connection and try again.")
    } finally {
      setBusy(false)
    }
  }

  if (complete) {
    return (
      <div className="rounded-xl border bg-surface-panel p-8 text-center">
        <h2 className="font-semibold">Thank you</h2>
        <p className="mt-2 text-sm text-text-subtle">
          Your responses have been shared with the research team.
        </p>
      </div>
    )
  }

  if (!sessionId) {
    return (
      <div className="space-y-3">
        <Button onClick={start} disabled={busy}>
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
            key={index}
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
            {messages.at(-1)?.role === "PARTICIPANT" && (
              <Button onClick={() => requestReply(messages)} size="sm" type="button" variant="outline">
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
          onKeyDown={(event) => {
            if (event.key === "Enter") void send()
          }}
          disabled={busy || Boolean(error)}
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
