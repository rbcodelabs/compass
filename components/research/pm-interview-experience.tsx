"use client"

import { useMemo, useRef, useState } from "react"
import { MicIcon, MessageSquareIcon, SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import type { PmInterviewTargetType } from "@/lib/pm-interview-contracts"
import { ResearchVoice } from "@/components/research/research-voice"

type Turn = { id: string; role: string; content: string; sequence: number }
type Proposal = { version: 1; brief: string; proposedFields: Record<string, { value: string | null; transcriptTurnIds: string[] } | undefined>; openQuestions: string[]; suggestedNextSteps: string[]; unknowns: string[] }
type Receipt = { version: 1; kind: "APPLIED"; selectedFields: string[]; before: Record<string, string | null>; after: Record<string, string | null>; at: string } | { version: 1; kind: "DISMISSED"; at: string }

export function PmInterviewExperience({ interviewId, orgSlug, workspaceSlug, targetType, targetTitle, omissions, initialTurns, initialProposal, initialReceipt, initialDisposition, initialGenerationState, initialReviewBaseline, initialContextFields, applicationDisabledReason, owner, voiceEnabled }: { interviewId: string; orgSlug: string; workspaceSlug: string; targetType: PmInterviewTargetType; targetTitle: string; omissions: string[]; initialTurns: Turn[]; initialProposal: Proposal | null; initialReceipt: Receipt | null; initialDisposition: string; initialGenerationState: string; initialReviewBaseline: { version: 1; fields: Record<string, string | null> }; initialContextFields: Record<string, string | null>; applicationDisabledReason: string | null; owner: boolean; voiceEnabled: boolean }) {
  const [mode, setMode] = useState<"CHOOSE" | "CHAT" | "VOICE">(initialProposal ? "CHAT" : "CHOOSE")
  const [turns, setTurns] = useState(initialTurns)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposal, setProposal] = useState(initialProposal)
  const [disposition, setDisposition] = useState(initialDisposition)
  const [receipt, setReceipt] = useState(initialReceipt)
  const [generationState, setGenerationState] = useState(initialGenerationState)
  const [reviewBaseline, setReviewBaseline] = useState(initialReviewBaseline)
  const applyKey = useRef<{ fingerprint: string; key: string } | null>(null)
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

  async function reloadInterview() {
    const response = await fetch(`/api/pm-interviews/${interviewId}${query}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "PM interview unavailable")
    setGenerationState(data.generationState)
    setReviewBaseline(data.reviewBaseline)
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
    } catch (caught) {
      setTurns(current => current.filter(turn => turn.id !== optimistic.id))
      setInput(answer)
      setError(caught instanceof Error ? caught.message : "Answer could not be saved")
    }
    finally { setBusy(false) }
  }

  function startVoice() {
    setError(null)
    if (!voiceEnabled) { setError("Voice is not enabled for this workspace. Continue in text."); setMode("CHAT"); return }
    setMode("VOICE")
  }

  async function continueText(transition?: { leaseId: string | null; settlement: "FINALIZED" | "DISCARD_PENDING" }) {
    if (transition?.leaseId) await api("/continue-in-text", transition)
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
    const selectedFields = fields.map(([field]) => field).filter(field => selected[field] ?? true)
    const fingerprint = JSON.stringify({ selectedFields: [...selectedFields].sort(), editedValues: edits })
    if (applyKey.current?.fingerprint !== fingerprint) applyKey.current = { fingerprint, key: crypto.randomUUID().replaceAll("-", "") }
    try { const result = await api("/apply", { selectedFields, editedValues: edits, idempotencyKey: applyKey.current.key }); setReceipt({ version: 1, kind: "APPLIED", selectedFields: result.selectedFields, before: result.before, after: result.after, at: result.at }); setDisposition("APPLIED") }
    catch (caught) {
      await reloadInterview().catch(() => undefined)
      setError(caught instanceof Error ? caught.message : "Changes could not be applied")
    }
    finally { setBusy(false) }
  }

  async function acknowledgeBaseline() {
    setBusy(true); setError(null)
    try { await api("/review-baseline"); setGenerationState("READY") }
    catch (caught) { await reloadInterview().catch(() => undefined); setError(caught instanceof Error ? caught.message : "Comparison changed") }
    finally { setBusy(false) }
  }

  async function dismiss() {
    setBusy(true); try { const result = await api("/dismiss", { idempotencyKey: crypto.randomUUID().replaceAll("-", "") }); setReceipt({ version: 1, kind: "DISMISSED", at: result.at }); setDisposition("DISMISSED") }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Proposal could not be dismissed") }
    finally { setBusy(false) }
  }

  if (proposal) return <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section className="space-y-5 rounded-xl border bg-surface-panel p-5"><div><p className="text-xs font-semibold uppercase tracking-wide text-primary">PM interview brief</p><h2 className="mt-2 text-lg font-semibold">{targetTitle}</h2><p className="mt-2 text-sm text-text-subtle">{proposal.brief}</p></div>
      {generationState === "STALE" && <div className="rounded-lg border border-border-strong bg-surface-inset p-4 text-sm"><p className="font-medium">The source item changed while this interview was open.</p>{Object.entries(reviewBaseline.fields).map(([field, value]) => initialContextFields[field] === value ? null : <p key={field} className="mt-2"><span className="font-medium">{field}:</span> was “{initialContextFields[field] ?? "empty"}”; now “{value ?? "empty"}”</p>)}{owner && <Button className="mt-3" variant="outline" onClick={acknowledgeBaseline} disabled={busy}>I’ve reviewed the current values</Button>}</div>}
      <div className="space-y-4"><h3 className="font-medium">Proposed changes</h3>{fields.length ? fields.map(([field, change]) => <label key={field} className="block rounded-lg border p-4"><span className="flex items-center gap-2 text-sm font-medium"><Checkbox checked={selected[field] ?? true} onCheckedChange={checked => setSelected(current => ({ ...current, [field]: checked === true }))} disabled={!owner || disposition !== "PENDING" || generationState === "STALE"} />{field}</span><Textarea className="mt-2" value={edits[field] ?? change.value ?? ""} onChange={event => setEdits(current => ({ ...current, [field]: event.target.value }))} disabled={!owner || disposition !== "PENDING" || generationState === "STALE"} /><div className="mt-2 space-y-1 text-xs text-text-muted">{change.transcriptTurnIds.map(id => { const turn = turns.find(item => item.id === id); return turn ? <p key={id}>“{turn.content}”</p> : null })}</div></label>) : <p className="text-sm text-text-muted">No field changes were proposed.</p>}</div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {applicationDisabledReason && <p className="rounded-lg bg-surface-inset p-3 text-sm text-text-subtle">{applicationDisabledReason}</p>}
      {owner && disposition === "PENDING" && <div className="flex flex-wrap gap-2"><Button onClick={apply} disabled={busy || fields.length === 0 || generationState === "STALE" || Boolean(applicationDisabledReason)}>Apply selected changes</Button><Button variant="outline" onClick={dismiss} disabled={busy}>Dismiss proposal</Button></div>}{disposition !== "PENDING" && <p className="rounded-lg bg-surface-inset p-3 text-sm">Proposal {disposition.toLowerCase()}.</p>}
    </section>
    <aside className="space-y-4"><ReceiptSummary receipt={receipt} /><Transcript turns={turns} /><ReviewList title="Open questions" items={proposal.openQuestions} /><ReviewList title="Suggested next steps" items={proposal.suggestedNextSteps} /><ReviewList title="Explicit unknowns" items={proposal.unknowns} /></aside>
  </div>

  if (!owner) return <section className="mx-auto w-full max-w-3xl rounded-xl border bg-surface-panel p-5"><h2 className="text-lg font-semibold">{targetTitle}</h2><p className="mt-1 text-sm text-text-subtle">Read-only PM interview history</p><ol className="mt-4 space-y-3">{turns.map(turn => <li key={turn.id} className="rounded-lg border p-3 text-sm"><span className="mb-1 block text-xs text-text-muted">{turn.role === "PARTICIPANT" ? "PM" : "Compass"}</span>{turn.content}</li>)}</ol></section>

  return <section className="mx-auto flex min-h-[34rem] w-full max-w-3xl flex-col rounded-xl border bg-surface-panel p-5">
    <div className="border-b pb-4"><p className="text-xs font-semibold uppercase tracking-wide text-primary">PM interview · {targetType.toLowerCase()} · about 15 minutes</p><h2 className="mt-1 text-lg font-semibold">{targetTitle}</h2><p className="mt-1 text-sm text-text-subtle">Compass uses this item, its parent chain, linked outcome, and directly linked evidence or feedback. PM answers remain internal interpretation—not customer validation.</p>{omissions.map(item => <p key={item} className="mt-1 text-xs text-text-muted">Context notice: {item}</p>)}</div>
    {mode === "CHOOSE" ? <div className="my-auto grid gap-3 sm:grid-cols-2"><Button className="h-auto justify-start p-5" variant="outline" onClick={startVoice}><MicIcon /><span><span className="block font-medium">Start voice</span><span className="block text-xs text-text-muted">Microphone requested after this click</span></span></Button><Button className="h-auto justify-start p-5" variant="outline" onClick={() => setMode("CHAT")}><MessageSquareIcon /><span><span className="block font-medium">Use text</span><span className="block text-xs text-text-muted">Type one answer at a time</span></span></Button></div> : mode === "VOICE" ? <ResearchVoice transport={{ basePath: `/api/pm-interviews/${interviewId}`, query, identity: `pm-${interviewId}`, atomicTextTransition: true }} onUseChat={continueText} onCompleted={(result) => { setProposal(result as Proposal); setSelected(Object.fromEntries(Object.keys((result as Proposal).proposedFields).map(key => [key, true]))) }} /> : <><ol className="flex-1 space-y-3 overflow-y-auto py-4">{turns.map(turn => <li key={`${turn.id}-${turn.sequence}`} className={`max-w-[88%] rounded-lg p-3 text-sm ${turn.role === "PARTICIPANT" ? "ml-auto bg-primary text-primary-foreground" : "border bg-background"}`}><span className="mb-1 block text-xs opacity-70">{turn.role === "PARTICIPANT" ? "You" : "Compass"}</span>{turn.content}</li>)}</ol><div className="flex gap-2 border-t pt-4"><Textarea aria-label="Your answer" value={input} onChange={event => setInput(event.target.value)} placeholder="Share what you know, what you believe, and what remains uncertain…" /><Button aria-label="Send answer" onClick={() => send()} disabled={busy || !input.trim()}><SendIcon /></Button></div><div className="mt-3 flex items-center justify-between">{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <span />}<Button variant="outline" onClick={finish} disabled={busy || !owner}>Finish and review</Button></div></>}
  </section>
}

function ReviewList({ title, items }: { title: string; items: string[] }) { return <section className="rounded-xl border bg-surface-panel p-4"><h3 className="font-medium">{title}</h3>{items.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-subtle">{items.map(item => <li key={item}>{item}</li>)}</ul> : <p className="mt-2 text-sm text-text-muted">None recorded.</p>}</section> }

function Transcript({ turns }: { turns: Turn[] }) { return <section className="rounded-xl border bg-surface-panel p-4"><h3 className="font-medium">Complete transcript</h3><ol className="mt-2 space-y-2">{turns.map(turn => <li className="text-sm text-text-subtle" key={turn.id}><span className="font-medium text-text-primary">{turn.role === "PARTICIPANT" ? "PM" : "Compass"}:</span> {turn.content}</li>)}</ol></section> }

function ReceiptSummary({ receipt }: { receipt: Receipt | null }) {
  if (!receipt) return null
  return <section className="rounded-xl border bg-surface-panel p-4"><h3 className="font-medium">Resolution receipt</h3>{receipt.kind === "DISMISSED"
    ? <p className="mt-2 text-sm text-text-subtle">Dismissed without applying changes · {new Date(receipt.at).toLocaleString()}</p>
    : <div className="mt-2 space-y-1 text-sm text-text-subtle"><p>Applied {receipt.selectedFields.length} field{receipt.selectedFields.length === 1 ? "" : "s"} · {new Date(receipt.at).toLocaleString()}</p>{receipt.selectedFields.map(field => <p key={field}><span className="font-medium text-text-primary">{field}:</span> {receipt.before[field] ?? "empty"} → {receipt.after[field] ?? "empty"}</p>)}</div>}</section>
}
