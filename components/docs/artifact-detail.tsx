"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { archiveArtifact, linkArtifact, replaceArtifactRevision, unlinkArtifact, updateArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { ArtifactPreview } from "./artifact-preview"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { MarkdownContent } from "@/components/markdown-content"

type ArtifactDetailProps = {
  artifact: { id: string; title: string; description: string | null; sourceType: string; status: string; currentRevision: { externalUrl: string | null } | null; revisions: Array<{ id: string; revisionNumber: number; filename: string | null; byteSize: number | null; externalUrl: string | null; createdAt: string }> }
  html?: string
  workspaceId: string
  basePath: string
  solutions: Array<{ id: string; title: string; linked: boolean }>
}

export function ArtifactDetail({ artifact, html, workspaceId, basePath, solutions }: ArtifactDetailProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [selectedSolution, setSelectedSolution] = useState("")
  const linked = solutions.filter((solution) => solution.linked)
  const available = solutions.filter((solution) => !solution.linked)
  const run = (fn: () => Promise<unknown>) => startTransition(async () => { try { setError(null); await fn(); router.refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : "Action failed") } })
  return <div className="mx-auto max-w-5xl p-4 sm:p-8 space-y-6">
    <header className="flex items-start justify-between gap-4">
      <div><div className="text-xs font-medium uppercase tracking-wide text-primary">Artifact · {artifact.sourceType === "EXTERNAL_LINK" ? "External" : "HTML prototype"}</div><h1 className="text-2xl font-semibold text-text-primary">{artifact.title}</h1>{artifact.description && <MarkdownContent className="mt-1 text-text-secondary">{artifact.description}</MarkdownContent>}</div>
      {artifact.status === "ACTIVE" && <Button variant="outline" disabled={pending} onClick={() => run(() => archiveArtifact(workspaceId, artifact.id, basePath))}>Archive</Button>}
    </header>
    {artifact.status === "ARCHIVED" && <div className="rounded-md bg-status-warning-surface p-3 text-sm text-status-warning">This artifact is archived.</div>}
    <ArtifactPreview title={artifact.title} html={html} externalUrl={artifact.currentRevision?.externalUrl} />
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
    <section className="rounded-lg border p-4"><h2 className="font-semibold mb-2">Revision history</h2><ol className="space-y-2 text-sm">{artifact.revisions.map((revision) => <li key={revision.id} className="flex justify-between"><span>Revision {revision.revisionNumber}{revision.filename ? ` · ${revision.filename}` : " · External URL"}</span><time>{new Date(revision.createdAt).toLocaleString()}</time></li>)}</ol></section>
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <Link href={basePath} className="text-sm text-primary">Back to Docs</Link>
  </div>
}
