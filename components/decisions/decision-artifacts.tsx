"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  return <div className="min-w-0 space-y-2.5">
    <p className="text-xs text-muted-foreground">Supporting Artifacts are live material, not frozen approval evidence.</p>
    {artifacts.length > 0 ? <ul className="space-y-2">{artifacts.map((artifact) => <li key={artifact.id} className="flex min-w-0 flex-col items-start gap-2 rounded-lg border border-border-default bg-surface-card p-3 sm:flex-row sm:items-center">
      <Link href={`${basePath}/artifacts/${artifact.id}`} className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] font-medium text-primary hover:underline">{artifact.title}</Link>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Artifact{artifact.currentRevision ? ` · Revision ${artifact.currentRevision.revisionNumber}` : ""}</span>{artifact.status === "ARCHIVED" && <span className="rounded-full border border-border-default bg-surface-inset px-2 py-0.5">Archived</span>}</span>
      {canEdit && <Button size="sm" variant="ghost" disabled={pending} aria-label={`Unlink ${artifact.title}`} onClick={() => run(() => unlinkArtifactDecision(workspaceId, artifact.id, requestId, basePath))}>Unlink</Button>}
    </li>)}</ul> : <p className="text-sm text-muted-foreground">No supporting Artifacts linked.</p>}
    {canEdit && (availableArtifacts.length > 0 ? <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <Select value={selected || null} onValueChange={(next) => setSelected(next ?? "")} disabled={pending}>
        <SelectTrigger aria-label="Artifact to link" disabled={pending} className="min-w-0 flex-1 bg-surface-card">
          <SelectValue placeholder="Select an Artifact…" />
        </SelectTrigger>
        <SelectContent>
          {availableArtifacts.map((artifact) => (
            <SelectItem key={artifact.id} value={artifact.id}>
              {artifact.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button disabled={pending || !selected} onClick={() => run(() => linkArtifactDecision(workspaceId, selected, requestId, basePath))}>Link</Button>
    </div> : <Link href={`${basePath}/artifacts/new`} className="inline-block text-sm text-primary hover:underline">Create an Artifact in Docs</Link>)}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
  </div>
}
