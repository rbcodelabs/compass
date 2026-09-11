"use client"

import { useMemo, useState } from "react"
import { MicIcon, MessageSquareIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import type { PmInterviewTargetType } from "@/lib/pm-interview-contracts"
import { ResearchVoice } from "@/components/research/research-voice"

type Turn = { id: string; role: string; content: string; sequence: number }
type Proposal = { version: 1; brief: string; proposedFields: Record<string, { value: string | null; transcriptTurnIds: string[] } | undefined>; openQuestions: string[]; suggestedNextSteps: string[]; unknowns: string[] }

export function PmInterviewExperience({ interviewId, orgSlug, workspaceSlug, targetType, targetTitle, omissions, initialTurns, initialProposal, initialDisposition, owner, voiceEnabled }: { interviewId: string; orgSlug: string; workspaceSlug: string; targetType: PmInterviewTargetType; targetTitle: string; omissions: string[]; initialTurns: Turn[]; initialProposal: Proposal | null; initialDisposition: string; owner: boolean; voiceEnabled: boolean }) {
  const [mode, setMode] = useState<"CHOOSE" | "CHAT" | "VOICE">(initialProposal ? "CHAT" : "CHOOSE")
  const [turns, setTurns] = useState(initialTurns)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState(initialProposal)
  const [disposition, setDisposition] = useState(initialDisposition)
  const query = `?orgSlug=${encodeURIComponent(orgSlug)}&workspaceSlug=${encodeURIComponent(workspaceSlug)}`
  const fields = useMemo(() => Object.entries(proposal?.proposedFields ?? {}).filter((entry): entry is [string, NonNullable<Proposal["proposedFields"][string]>] => Boolean(entry[1])), [proposal])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})

  async function api(path: string, body?: unknown) {
    const response = await fetch(`/api/pm-interviews/${interviewId}${path}${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "PM interview unavailable")
    return data
  }

  async function send(answer = input) {
    if (!answer.trim() || busy) return
    setBusy(true); setError(null); setInput("")
    const optimistic: Turn = { id: crypto.randomUUID(), role: "PARTICIPANT", content: answer.trim(), sequence: turns.length }
    setTurns(current => [...current, optimistic])
    try {
      const data = await api("/respond", { answer: answer.trim(), idempotencyKey: crypto.randomUUID().replaceAll("-", "") })
      setTurns(current => [...current, { id: crypto.randomUUID(), role: "INTERVIEWER", content: data.message, sequence: current.length }])
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Answer could not be saved") }
    finally { setBusy(false) }
  }

  function startVoice() {
    setError(null)
    if (!voiceEnabled) { setError("Voice is not enabled for this workspace. Continue in text."); setMode("CHAT"); return }
    setMode("VOICE")
  }

  async function continueText(retiredLeaseId?: string) {
    await api("/continue-in-text", { retiredLeaseId })
    setMode("CHAT")
  }

  async function finish() {
    setBusy(true); setError(null)
    try { const result = await api("/complete"); setProposal(result); setSelected(Object.fromEntries(Object.keys(result.proposedFields).map(key => [key, true]))) }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Proposal generation failed") }
    finally { setBusy(false) }
  }

  async function apply() {
    setBusy(true); setError(null)
    try { await api("/apply", { selectedFields: fields.map(([field]) => field).filter(field => selected[field] ?? true), editedValues: edits, idempotencyKey: crypto.randomUUID().replaceAll("-", "") }); setDisposition("APPLIED") }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Changes could not be applied") }
    finally { setBusy(false) }
  }

  async function dismiss() {
    setBusy(true); try { await api("/dismiss", { idempotencyKey: crypto.randomUUID().replaceAll("-", "") }); setDisposition("DISMISSED") }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Proposal could not be dismissed") }
    finally { setBusy(false) }
  }

  if (proposal) return <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section className="space-y-5 rounded-xl border bg-surface-panel p-5"><div><p className="text-xs font-semibold uppercase tracking-wide text-primary">PM interview brief</p><h2 className="mt-2 text-lg font-semibold">{targetTitle}</h2><p className="mt-2 text-sm text-text-subtle">{proposal.brief}</p></div>
      <div className="space-y-4"><h3 className="font-medium">Proposed changes</h3>{fields.length ? fields.map(([field, change]) => <label key={field} className="block rounded-lg border p-4"><span className="flex items-center gap-2 text-sm font-medium"><Checkbox checked={selected[field] ?? true} onCheckedChange={checked => setSelected(current => ({ ...current, [field]: checked === true }))} disabled={!owner || disposition !== "PENDING"} />{field}</span><Textarea className="mt-2" value={edits[field] ?? change.value ?? ""} onChange={event => setEdits(current => ({ ...current, [field]: event.target.value }))} disabled={!owner || disposition !== "PENDING"} /><p className="mt-1 text-xs text-text-muted">Supported by {change.transcriptTurnIds.length} saved turn(s).</p></label>) : <p className="text-sm text-text-muted">No field changes were proposed.</p>}</div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {owner && disposition === "PENDING" && <div className="flex flex-wrap gap-2"><Button onClick={apply} disabled={busy || fields.length === 0}>Apply selected changes</Button><Button variant="outline" onClick={dismiss} disabled={busy}>Dismiss proposal</Button></div>}{disposition !== "PENDING" && <p className="rounded-lg bg-surface-inset p-3 text-sm">Proposal {disposition.toLowerCase()}.</p>}
    </section>
    <aside className="space-y-4"><ReviewList title="Open questions" items={proposal.openQuestions} /><ReviewList title="Suggested next steps" items={proposal.suggestedNextSteps} /><ReviewList title="Explicit unknowns" items={proposal.unknowns} /></aside>
  </div>

  return <section className="mx-auto flex min-h-[34rem] w-full max-w-3xl flex-col rounded-xl border bg-surface-panel p-5">
    <div className="border-b pb-4"><p className="text-xs font-semibold uppercase tracking-wide text-primary">PM interview · {targetType.toLowerCase()} · about 15 minutes</p><h2 className="mt-1 text-lg font-semibold">{targetTitle}</h2><p className="mt-1 text-sm text-text-subtle">Compass uses this item, its parent chain, linked outcome, and directly linked evidence or feedback. PM answers remain internal interpretation—not customer validation.</p>{omissions.map(item => <p key={item} className="mt-1 text-xs text-text-muted">Context notice: {item}</p>)}</div>
    {mode === "CHOOSE" ? <div className="my-auto grid gap-3 sm:grid-cols-2"><Button className="h-auto justify-start p-5" variant="outline" onClick={startVoice}><MicIcon /><span><span className="block font-medium">Start voice</span><span className="block text-xs text-text-muted">Microphone requested after this click</span></span></Button><Button className="h-auto justify-start p-5" variant="outline" onClick={() => setMode("CHAT")}><MessageSquareIcon /><span><span className="block font-medium">Use text</span><span className="block text-xs text-text-muted">Type one answer at a time</span></span></Button></div> : mode === "VOICE" ? <ResearchVoice transport={{ basePath: `/api/pm-interviews/${interviewId}`, query, identity: `pm-${interviewId}` }} onUseChat={continueText} onCompleted={(result) => { setProposal(result as Proposal); setSelected(Object.fromEntries(Object.keys((result as Proposal).proposedFields).map(key => [key, true]))) }} /> : <><ol className="flex-1 space-y-3 overflow-y-auto py-4">{turns.map(turn => <li key={`${turn.id}-${turn.sequence}`} className={`max-w-[88%] rounded-lg p-3 text-sm ${turn.role === "PARTICIPANT" ? "ml-auto bg-primary text-primary-foreground" : "border bg-background"}`}><span className="mb-1 block text-xs opacity-70">{turn.role === "PARTICIPANT" ? "You" : "Compass"}</span>{turn.content}</li>)}</ol><div className="flex gap-2 border-t pt-4"><Textarea aria-label="Your answer" value={input} onChange={event => setInput(event.target.value)} placeholder="Share what you know, what you believe, and what remains uncertain…" /><Button aria-label="Send answer" onClick={() => send()} disabled={busy || !input.trim()}><SendIcon /></Button></div><div className="mt-3 flex items-center justify-between">{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <span />}<Button variant="outline" onClick={finish} disabled={busy || !owner}>Finish and review</Button></div></>}
  </section>
}

function ReviewList({ title, items }: { title: string; items: string[] }) { return <section className="rounded-xl border bg-surface-panel p-4"><h3 className="font-medium">{title}</h3>{items.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-subtle">{items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-sm text-text-muted">None recorded.</p>}</section> }
