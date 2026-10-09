"use client"

import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { useEffect, useRef, useState, useTransition } from "react"
import { Camera, MessageSquare } from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { archiveArtifact, captureArtifactThumbnail, linkArtifact, replaceArtifactRevision, unlinkArtifact, unlinkArtifactDecision, updateArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { ArtifactViewer } from "./artifact-viewer"
import type { ArtifactSlideDto } from "@/lib/artifact-slides"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/markdown-content"
import { Discussion } from "@/components/comments/discussion"
import { DocPanelShell } from "./doc-panel-shell"
import type { PanelPin } from "@/lib/panel-pin"
import type { ArtifactThumbnailDto } from "@/lib/artifacts"

type ArtifactDetailProps = {
  artifact: { id: string; title: string; description: string | null; sourceType: string; kind?: "DOCUMENT" | "SLIDE_DECK"; status: string; currentRevision: { externalUrl: string | null; thumbnail: ArtifactThumbnailDto | null } | null; revisions: Array<{ id: string; revisionNumber: number; filename: string | null; byteSize: number | null; externalUrl: string | null; createdAt: string }> }
  html?: string
  /** Present only for a SLIDE_DECK Artifact. */
  slides?: ArtifactSlideDto[]
  /** Zero-based slide to open on, from `?slide=`. */
  initialSlideIndex?: number
  initialCommentsPin?: PanelPin
  workspaceId: string
  basePath: string
  solutions: Array<{ id: string; title: string; linked: boolean }>
  decisions: Array<{ id: string; title: string; state: string }>
}

export function ArtifactDetail({ artifact, html, slides, initialSlideIndex, workspaceId, basePath, solutions, decisions, initialCommentsPin }: ArtifactDetailProps) {
  const labels = useLabels()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selectedSolution, setSelectedSolution] = useState("")
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsVisits, setCommentsVisits] = useState(0)
  const commentsTrigger = useRef<HTMLButtonElement>(null)
  // Where ArtifactViewer portals its actions (Leave feedback, View full screen) so they sit in the top bar.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)
  const artifactTypeLabel = `Artifact · ${artifact.sourceType === "EXTERNAL_LINK" ? "External" : artifact.kind === "SLIDE_DECK" ? "Slide deck" : "HTML prototype"}`
  const changeCommentsOpen = (open: boolean) => {
    setCommentsOpen(open)
    if (open) setCommentsVisits((visits) => visits + 1)
    else commentsTrigger.current?.focus()
  }
  const linked = solutions.filter((solution) => solution.linked)
  const available = solutions.filter((solution) => !solution.linked)
  const run = (fn: () => Promise<unknown>) => startTransition(async () => { try { setError(null); await fn(); router.refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : "Action failed") } })
  return <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
    {/* @container: layout responds to this column's width, not the viewport's — the docked Comments panel narrows the column without changing the viewport. */}
    <div data-slot="artifact-content-column" className="@container min-w-0 flex-1 overflow-y-auto">
    {/* Standard top bar (same pattern as the doc editor toolbar): context on the left, every action on the right. Labels collapse to icons when the column is narrow. */}
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border-default bg-surface-panel/90 px-4 py-1.5 backdrop-blur-sm @2xl:px-8">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-text-subtle">{artifactTypeLabel}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div ref={setToolbarSlot} className="contents" />
        <Button ref={commentsTrigger} variant="outline" size="sm" aria-expanded={commentsOpen} aria-label="Comments" title="Comments" onClick={() => changeCommentsOpen(!commentsOpen)}><MessageSquare aria-hidden /><span className="hidden @2xl:inline">Comments</span></Button>
        {artifact.status === "ACTIVE" && <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => archiveArtifact(workspaceId, artifact.id, basePath))}>Archive</Button>}
      </div>
    </div>
    <div className="mx-auto max-w-5xl space-y-5 p-4 @2xl:p-8 @2xl:space-y-6">
    <header className="min-w-0">
      <h1 className="break-words [overflow-wrap:anywhere] text-xl font-semibold leading-tight text-text-primary @2xl:text-2xl">{artifact.title}</h1>
      {artifact.description && <ArtifactDescription>{artifact.description}</ArtifactDescription>}
    </header>
    {artifact.status === "ARCHIVED" && <div className="rounded-md bg-status-warning-surface p-3 text-sm text-status-warning">This artifact is archived.</div>}
    <ArtifactViewer title={artifact.title} html={html} slides={slides} initialSlideIndex={initialSlideIndex} toolbarSlot={toolbarSlot} externalUrl={artifact.currentRevision?.externalUrl} thumbnail={artifact.currentRevision?.thumbnail} artifactId={artifact.id} fullScreenHref={`${basePath}/artifacts/${artifact.id}/full-screen`} onFeedbackPosted={() => setCommentsVisits((visits) => visits + 1)} />
    {artifact.sourceType === "EXTERNAL_LINK" && artifact.status === "ACTIVE" && artifact.currentRevision?.externalUrl && <ArtifactScreenshotControls
      key={latestRevisionCreatedAt(artifact.revisions)}
      workspaceId={workspaceId}
      artifactId={artifact.id}
      basePath={basePath}
      hasThumbnail={Boolean(artifact.currentRevision.thumbnail)}
      revisionCreatedAt={latestRevisionCreatedAt(artifact.revisions)}
    />}
    <div className="grid gap-6 @3xl:grid-cols-2">
      <form className="space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); run(() => updateArtifact(workspaceId, artifact.id, { title: String(data.get("title")), description: String(data.get("description")), ...(artifact.sourceType === "HTML_UPLOAD" ? { kind: data.get("kind") === "SLIDE_DECK" ? "SLIDE_DECK" as const : "DOCUMENT" as const } : {}) }, basePath)) }}>
        <h2 className="font-semibold">Details</h2><Input name="title" defaultValue={artifact.title} required /><Textarea name="description" defaultValue={artifact.description ?? ""} />{artifact.sourceType === "HTML_UPLOAD" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="kind" value="SLIDE_DECK" defaultChecked={artifact.kind === "SLIDE_DECK"} />Show as a slide deck</label>}<Button type="submit" disabled={pending}>Save details</Button>
      </form>
      <form className="space-y-3 rounded-lg border p-4" onSubmit={(event) => { event.preventDefault(); run(() => replaceArtifactRevision(workspaceId, artifact.id, artifact.sourceType, new FormData(event.currentTarget), basePath)) }}>
        <h2 className="font-semibold">New revision</h2>{artifact.sourceType === "EXTERNAL_LINK" ? <Input name="url" type="url" required placeholder="https://…" /> : <Input name="file" type="file" accept=".html,text/html" required />}<Button type="submit" disabled={pending}>Replace current revision</Button>
      </form>
    </div>
    <section className="rounded-lg border p-4 space-y-3"><h2 className="font-semibold">{`Linked ${labels.solution.lowerPlural}`}</h2>{linked.length === 0 ? <p className="text-sm text-text-subtle">{`Not linked to ${labels.solution.indefinite}.`}</p> : <ul className="space-y-2">{linked.map((solution) => <li key={solution.id} className="flex items-center justify-between gap-2"><span>{solution.title}</span><Button size="sm" variant="ghost" onClick={() => run(() => unlinkArtifact(workspaceId, artifact.id, solution.id, basePath))}>Unlink</Button></li>)}</ul>}
      {available.length > 0 && <div className="flex gap-2"><select aria-label={`${labels.solution.singular} to link`} className="flex-1 rounded-md border px-3 text-sm" value={selectedSolution} onChange={(event) => setSelectedSolution(event.target.value)}><option value="">{`Select ${labels.solution.indefinite}…`}</option>{available.map((solution) => <option key={solution.id} value={solution.id}>{solution.title}</option>)}</select><Button disabled={!selectedSolution || pending} onClick={() => run(() => linkArtifact(workspaceId, artifact.id, selectedSolution, basePath))}>Link</Button></div>}
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

/** Descriptions longer than this collapse behind "Show more" so the preview stays above the fold. */
const DESCRIPTION_COLLAPSE_CHARS = 200

function ArtifactDescription({ children }: { children: string }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = children.length > DESCRIPTION_COLLAPSE_CHARS
  const collapsed = collapsible && !expanded
  return <div className="mt-1">
    <div className={collapsed ? "relative max-h-16 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]" : undefined}>
      <MarkdownContent className="text-text-secondary">{children}</MarkdownContent>
    </div>
    {collapsible && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="mt-1 text-xs font-medium text-primary hover:underline">{expanded ? "Show less" : "Show more"}</button>}
  </div>
}

/** How long after a link is saved the page keeps checking for its background capture. */
const BACKGROUND_CAPTURE_WINDOW_MS = 2 * 60_000
const BACKGROUND_CAPTURE_POLL_MS = 5_000

function latestRevisionCreatedAt(revisions: Array<{ revisionNumber: number; createdAt: string }>) {
  return revisions.reduce<{ revisionNumber: number; createdAt: string } | null>((latest, revision) => !latest || revision.revisionNumber > latest.revisionNumber ? revision : latest, null)?.createdAt ?? ""
}

/**
 * The "Capture screenshot" / "Refresh screenshot" button for an external link.
 *
 * Saving a link schedules a background capture (scheduleArtifactThumbnailCapture),
 * which lands a few seconds after the page has already rendered without one. So
 * for a just-saved revision with no thumbnail yet, the page refreshes itself on a
 * short interval until the screenshot appears or the window closes — after that
 * the background capture is assumed to have failed, and the button is the retry.
 */
function ArtifactScreenshotControls({ workspaceId, artifactId, basePath, hasThumbnail, revisionCreatedAt }: {
  workspaceId: string; artifactId: string; basePath: string; hasThumbnail: boolean; revisionCreatedAt: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(() => !hasThumbnail && Date.now() - Date.parse(revisionCreatedAt) < BACKGROUND_CAPTURE_WINDOW_MS)
  const showWaiting = waiting && !hasThumbnail

  useEffect(() => {
    if (!showWaiting) return
    const remaining = BACKGROUND_CAPTURE_WINDOW_MS - (Date.now() - Date.parse(revisionCreatedAt))
    const poll = setInterval(() => router.refresh(), BACKGROUND_CAPTURE_POLL_MS)
    const stop = setTimeout(() => setWaiting(false), Math.max(remaining, 0))
    return () => { clearInterval(poll); clearTimeout(stop) }
  }, [showWaiting, revisionCreatedAt, router])

  const capture = () => startTransition(async () => {
    setError(null)
    const result = await captureArtifactThumbnail(workspaceId, artifactId, `${basePath}/artifacts/${artifactId}`)
    if (result.ok) { setWaiting(false); router.refresh() } else setError(result.error)
  })

  return <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
    <Button variant="outline" size="sm" disabled={pending} onClick={capture}>
      <Camera aria-hidden />{pending ? "Capturing…" : hasThumbnail ? "Refresh screenshot" : "Capture screenshot"}
    </Button>
    <p role="status" aria-live="polite" className="text-xs text-text-subtle">
      {pending ? "Rendering the page in a sandboxed browser — this takes a few seconds." : showWaiting ? "Capturing a screenshot in the background…" : null}
    </p>
    {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
  </div>
}
