"use client"

import { useCallback, useEffect, useState } from "react"

type Comment = { id: string; parentId: string | null; body: string; createdAt: string }
type Phase = "loading" | "signed-out" | "link-sent" | "ready" | "unavailable"

/**
 * Feedback panel for outsiders. It only ever receives the viewer's own comments from the
 * server; there is no internal thread to filter here because none is ever sent.
 */
export function ShareComments({ token }: { token: string }) {
  const base = `/s/${token}`
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>("loading")
  const [email, setEmail] = useState("")
  const [signedInAs, setSignedInAs] = useState<string | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [draft, setDraft] = useState("")
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch(`${base}/comments`, { cache: "no-store" })
    if (response.status === 401) return setPhase("signed-out")
    if (!response.ok) return setPhase("unavailable")
    const data = (await response.json()) as { email: string; comments: Comment[] }
    setSignedInAs(data.email)
    setComments(data.comments)
    setPhase("ready")
  }, [base])

  useEffect(() => {
    void load()
  }, [load])

  async function sendLink(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${base}/auth/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) })
      if (response.ok) setPhase("link-sent")
      else setMessage(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't send the link.")
    } finally {
      setBusy(false)
    }
  }

  async function post(event: React.FormEvent) {
    event.preventDefault()
    if (!draft.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${base}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: draft }) })
      if (response.ok) {
        setDraft("")
        await load()
      } else setMessage(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Couldn't post your comment.")
    } finally {
      setBusy(false)
    }
  }

  if (phase === "unavailable") return null
  return (
    <div className="fixed bottom-4 right-4 z-10 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-background shadow-lg">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium" aria-expanded={open}>
        Leave feedback
        <span aria-hidden>{open ? "–" : "+"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border p-3 text-sm">
          {phase === "loading" ? <p className="text-text-subtle">Loading…</p> : null}
          {phase === "signed-out" ? (
            <form onSubmit={sendLink} className="space-y-2">
              <p className="text-text-subtle">Confirm your email to comment. Only you and the team will see your comments.</p>
              <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" className="w-full rounded-md border border-border bg-background px-2 py-1.5" />
              <button type="submit" disabled={busy} className="w-full rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-60">Email me a link</button>
            </form>
          ) : null}
          {phase === "link-sent" ? <p>If that address can receive mail, a confirmation link is on its way. Open it in this browser to start commenting.</p> : null}
          {phase === "ready" ? (
            <>
              <p className="text-xs text-text-subtle">Signed in as {signedInAs}. You only see your own comments.</p>
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {comments.map((comment) => (
                  <li key={comment.id} className="rounded-md bg-muted/40 p-2">
                    <p className="whitespace-pre-wrap break-words">{comment.body}</p>
                    <p className="mt-1 text-xs text-text-subtle">{new Date(comment.createdAt).toLocaleString()}</p>
                  </li>
                ))}
              </ul>
              <form onSubmit={post} className="space-y-2">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} rows={3} placeholder="Your comment" className="w-full rounded-md border border-border bg-background px-2 py-1.5" />
                <button type="submit" disabled={busy || !draft.trim()} className="w-full rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-60">Post comment</button>
              </form>
            </>
          ) : null}
          {message ? <p role="alert" className="text-destructive">{message}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
