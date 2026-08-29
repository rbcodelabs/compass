"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Message = { role: "INTERVIEWER" | "PARTICIPANT"; content: string }

export function ResearchChat({ token }: { token: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([]); const [input, setInput] = useState(""); const [busy, setBusy] = useState(false); const [complete, setComplete] = useState(false)
  async function start() { setBusy(true); const res = await fetch("/api/research/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }); const data = await res.json(); if (res.ok) { setSessionId(data.sessionId); setMessages([{ role: "INTERVIEWER", content: data.message }]) } setBusy(false) }
  async function send() { if (!input.trim() || !sessionId) return; const next = [...messages, { role: "PARTICIPANT" as const, content: input.trim() }]; setMessages(next); setInput(""); setBusy(true); const res = await fetch("/api/research/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, sessionId, messages: next }) }); const data = await res.json(); if (res.ok) setMessages([...next, { role: "INTERVIEWER", content: data.message }]); setBusy(false) }
  async function finish() { if (!sessionId) return; setBusy(true); const res = await fetch("/api/research/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, sessionId, messages }) }); if (res.ok) setComplete(true); setBusy(false) }
  if (complete) return <div className="rounded-xl border bg-surface-panel p-8 text-center"><h2 className="font-semibold">Thank you</h2><p className="mt-2 text-sm text-text-subtle">Your responses have been shared with the research team.</p></div>
  if (!sessionId) return <Button onClick={start} disabled={busy}>{busy ? "Starting…" : "Start interview"}</Button>
  return <div className="flex flex-1 flex-col"><div className="space-y-3">{messages.map((m, i) => <div key={i} className={`max-w-[85%] rounded-xl px-4 py-3 text-sm ${m.role === "PARTICIPANT" ? "ml-auto bg-primary text-white" : "border bg-surface-panel"}`}>{m.content}</div>)}</div><div className="mt-6 flex gap-2"><Input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void send() }} disabled={busy} placeholder="Type your response…" /><Button onClick={send} disabled={busy || !input.trim()}>Send</Button></div><Button className="mt-3 self-end" variant="ghost" onClick={finish} disabled={busy}>Finish interview</Button></div>
}
