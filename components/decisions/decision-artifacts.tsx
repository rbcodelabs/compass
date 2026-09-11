"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { linkArtifactDecision, unlinkArtifactDecision } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"

type Props = {
  workspaceId: string
  requestId: string
  basePath: string
  canEdit: boolean
  artifacts: Array<{ id: string; title: string; status: string; currentRevision: { revisionNumber: number } | null }>
  availableArtifacts: Array<{ id: string; title: string }>
}

export function DecisionArtifacts({ workspaceId, requestId, basePath, canEdit, artifacts, availableArtifacts }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState("")
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => startTransition(async () => {
    setError(null)
    try { await action(); setSelected(""); router.refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update supporting Artifacts") }
  })
  return <div className="min-w-0 space-y-2">
    <p className="text-xs text-muted-foreground">Supporting Artifacts are live material, not frozen approval evidence.</p>
    {artifacts.length > 0 ? <ul className="space-y-2">{artifacts.map((artifact) => <li key={artifact.id} className="flex min-w-0 flex-col items-start gap-2 rounded-md border p-3 sm:flex-row sm:items-center">
      <Link href={`${basePath}/artifacts/${artifact.id}`} className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] font-medium text-primary hover:underline">{artifact.title}</Link>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Artifact{artifact.currentRevision ? ` · Revision ${artifact.currentRevision.revisionNumber}` : ""}</span>{artifact.status === "ARCHIVED" && <span className="rounded-full border px-2 py-0.5">Archived</span>}</span>
      {canEdit && <Button size="sm" variant="ghost" disabled={pending} aria-label={`Unlink ${artifact.title}`} onClick={() => run(() => unlinkArtifactDecision(workspaceId, artifact.id, requestId, basePath))}>Unlink</Button>}
    </li>)}</ul> : <p className="text-sm text-muted-foreground">No supporting Artifacts linked.</p>}
    {canEdit && (availableArtifacts.length > 0 ? <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
      <select aria-label="Artifact to link" disabled={pending} value={selected} onChange={(event) => setSelected(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"><option value="">Select an Artifact…</option>{availableArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</select>
      <Button disabled={pending || !selected} onClick={() => run(() => linkArtifactDecision(workspaceId, selected, requestId, basePath))}>Link</Button>
    </div> : <Link href={`${basePath}/artifacts/new`} className="inline-block text-sm text-primary hover:underline">Create an Artifact in Docs</Link>)}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
  </div>
}
