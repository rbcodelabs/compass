"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export function ArtifactCreateForm({ workspaceId, basePath }: { workspaceId: string; basePath: string }) {
  const router = useRouter()
  const [sourceType, setSourceType] = useState("HTML_UPLOAD")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  return <form className="space-y-5" onSubmit={(event) => {
    event.preventDefault()
    const form = event.currentTarget
    startTransition(async () => {
      try {
        setError(null)
        const result = await createArtifact(workspaceId, new FormData(form), basePath)
        router.push(`${basePath}/artifacts/${result.id}`)
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create artifact") }
    })
  }}>
    <div className="flex gap-2" role="group" aria-label="Artifact source">
      {[["HTML_UPLOAD", "Upload HTML"], ["EXTERNAL_LINK", "External link"]].map(([value, label]) => <Button key={value} type="button" variant={sourceType === value ? "default" : "outline"} onClick={() => setSourceType(value)}>{label}</Button>)}
    </div>
    <input type="hidden" name="sourceType" value={sourceType} />
    <label className="block text-sm font-medium">Title<Input name="title" required maxLength={255} className="mt-1" /></label>
    <label className="block text-sm font-medium">Description<Textarea name="description" className="mt-1" /></label>
    {sourceType === "HTML_UPLOAD" ? <label className="block text-sm font-medium">Self-contained HTML file<Input name="file" type="file" accept=".html,text/html" required className="mt-1" /><span className="block mt-1 text-xs text-slate-500">One .html file, up to 2 MB. Network access is blocked in preview.</span></label> : <label className="block text-sm font-medium">External URL<Input name="url" type="url" required placeholder="https://…" className="mt-1" /></label>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create artifact"}</Button>
  </form>
}
