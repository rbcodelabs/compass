"use client"

import { useRef, useState, useTransition } from "react"
import { MessageSquare } from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { archiveArtifact, linkArtifact, replaceArtifactRevision, unlinkArtifact, unlinkArtifactDecision, updateArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { ArtifactViewer } from "./artifact-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/markdown-content"
import { Discussion } from "@/components/comments/discussion"
import { DocPanelShell } from "./doc-panel-shell"
import type { PanelPin } from "@/lib/panel-pin"

type ArtifactDetailProps = {
  artifact: { id: string; title: string; description: string | null; sourceType: string; status: string; currentRevision: { externalUrl: string | null } | null; revisions: Array<{ id: string; revisionNumber: number; filename: string | null; byteSize: number | null; externalUrl: string | null; createdAt: string }> }
  html?: string
  initialCommentsPin?: PanelPin
  workspaceId: string
  basePath: string
  solutions: Array<{ id: string; title: string; linked: boolean }>
  decisions: Array<{ id: string; title: string; state: string }>
}

export function ArtifactDetail({ artifact, html, workspaceId, basePath, solutions, decisions, initialCommentsPin }: ArtifactDetailProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selectedSolution, setSelectedSolution] = useState("")
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsVisits, setCommentsVisits] = useState(0)
  const commentsTrigger = useRef<HTMLButtonElement>(null)
  const changeCommentsOpen = (open: boolean) => {
    setCommentsOpen(open)
    if (open) setCommentsVisits((visits) => visits + 1)
    else commentsTrigger.current?.focus()
  }
  const linked = solutions.filter((solution) => solution.linked)
  const available = solutions.filter((solution) => !solution.linked)
  const run = (fn: () => Promise<unknown>) => startTransition(async () => { try { setError(null); await fn(); router.refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : "Action failed") } })
  return <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
    <div data-slot="artifact-content-column" className="min-w-0 flex-1 overflow-y-auto">
    <div className="mx-auto max-w-5xl p-4 sm:p-8 space-y-6">
    <header className="flex flex-col items-start justify-between gap-4 sm:flex-row">
      <div className="min-w-0"><div className="text-xs font-medium uppercase tracking-wide text-primary">Artifact · {artifact.sourceType === "EXTERNAL_LINK" ? "External" : "HTML prototype"}</div><h1 className="break-words [overflow-wrap:anywhere] text-2xl font-semibold text-text-primary">{artifact.title}</h1>{artifact.description && <MarkdownContent className="mt-1 text-text-secondary">{artifact.description}</MarkdownContent>}</div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button ref={commentsTrigger} variant="outline" aria-expanded={commentsOpen} onClick={() => changeCommentsOpen(!commentsOpen)}><MessageSquare aria-hidden />Comments</Button>
        {artifact.status === "ACTIVE" && <Button variant="outline" disabled={pending} onClick={() => run(() => archiveArtifact(workspaceId, artifact.id, basePath))}>Archive</Button>}
      </div>
    </header>
    {artifact.status === "ARCHIVED" && <div className="rounded-md bg-status-warning-surface p-3 text-sm text-status-warning">This artifact is archived.</div>}
    <ArtifactViewer title={artifact.title} html={html} externalUrl={artifact.currentRevision?.externalUrl} artifactId={artifact.id} fullScreenHref={`${basePath}/artifacts/${artifact.id}/full-screen`} onFeedbackPosted={() => setCommentsVisits((visits) => visits + 1)} />
    <div className="grid gap-6 md:grid-cols-2">
      <form className="space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); run(() => updateArtifact(workspaceId, artifact.id, { title: String(data.get("title")), description: String(data.get("description")) }, basePath)) }}>
        <h2 className="font-semibold">Details</h2><Input name="title" defaultValue={artifact.title} required /><Textarea name="description" defaultValue={artifact.description ?? ""} /><Button type="submit" disabled={pending}>Save details</Button>
      </form>
      <form className="space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); run(() => replaceArtifactRevision(workspaceId, artifact.id, artifact.sourceType, new FormData(event.currentTarget), basePath)) }}>
        <h2 className="font-semibold">New revision</h2>{artifact.sourceType === "EXTERNAL_LINK" ? <Input name="url" type="url" required placeholder="https://…" /> : <Input name="file" type="file" accept=".html,text/html" required />}<Button type="submit" disabled={pending}>Replace current revision</Button>
      </form>
    </div>
    <section className="rounded-lg border p-4 space-y-3"><h2 className="font-semibold">Linked solutions</h2>{linked.length === 0 ? <p className="text-sm text-text-subtle">Not linked to a solution.</p> : <ul className="space-y-2">{linked.map((solution) => <li key={solution.id} className="flex items-center justify-between gap-2"><span>{solution.title}</span><Button size="sm" variant="ghost" onClick={() => run(() => unlinkArtifact(workspaceId, artifact.id, solution.id, basePath))}>Unlink</Button></li>)}</ul>}
      {available.length > 0 && <div className="flex gap-2"><select aria-label="Solution to link" className="flex-1 rounded-md border px-3 text-sm" value={selectedSolution} onChange={(event) => setSelectedSolution(event.target.value)}><option value="">Select a solution…</option>{available.map((solution) => <option key={solution.id} value={solution.id}>{solution.title}</option>)}</select><Button disabled={!selectedSolution || pending} onClick={() => run(() => linkArtifact(workspaceId, artifact.id, selectedSolution, basePath))}>Link</Button></div>}
    </section>
    <section className="min-w-0 rounded-lg border p-4 space-y-3">
      <h2 className="font-semibold">Linked decisions</h2>
      <p className="text-xs text-muted-foreground">Live supporting material, not frozen approval evidence.</p>
      {decisions.length === 0 ? <p className="text-sm text-text-subtle">Not linked to a Decision. Add this Artifact from a Decision’s “Linked to” section.</p> : <ul className="space-y-2">{decisions.map((decision) => <li key={decision.id} className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center">
        <Link className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] text-primary hover:underline" href={`${basePath.replace(/\/docs$/, "")}/reviews/${decision.id}`}>{decision.title}</Link>
        <span className="text-xs text-muted-foreground">{decision.state === "DECIDED" ? "Decided" : "Pending"}</span>
        <Button size="sm" variant="ghost" disabled={pending} aria-label={`Unlink ${decision.title}`} onClick={() => run(() => unlinkArtifactDecision(workspaceId, artifact.id, decision.id, basePath))}>Unlink</Button>
      </li>)}</ul>}
    </section>
    <section className="rounded-lg border p-4"><h2 className="font-semibold mb-2">Revision history</h2><ol className="space-y-2 text-sm">{artifact.revisions.map((revision) => <li key={revision.id} className="flex justify-between"><span>Revision {revision.revisionNumber}{revision.filename ? ` · ${revision.filename}` : " · External URL"}</span><time>{new Date(revision.createdAt).toLocaleString()}</time></li>)}</ol></section>
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <Link href={basePath} className="text-sm text-primary">Back to Docs</Link>
    </div>
    </div>
    {commentsVisits > 0 && <Discussion key={artifact.id} targetType="ARTIFACT" targetId={artifact.id} refreshKey={commentsVisits} render={(content) => (
      <DocPanelShell panelId="artifactComments" title="Comments" icon={<MessageSquare aria-hidden className="size-4" />} open={commentsOpen} onOpenChange={changeCommentsOpen} initialPin={initialCommentsPin} contentColumnSelector='[data-slot="artifact-content-column"]' returnFocusRef={commentsTrigger}>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-xs text-muted-foreground">Whole-artifact discussion · continues across revisions.</p>
          {content}
        </div>
      </DocPanelShell>
    )} />}
  </div>
}
