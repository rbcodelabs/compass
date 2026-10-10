"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { createArtifact } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export function ArtifactCreateForm({ workspaceId, basePath }: { workspaceId: string; basePath: string }) {
  const router = useRouter()
  const [sourceType, setSourceType] = useState("HTML_UPLOAD")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const fileInput = useRef<HTMLInputElement>(null)
  // "Upload HTML" is the default source, so selecting it again would otherwise
  // do nothing visible; open the file picker instead.
  const chooseSource = (value: string) => {
    if (value === "HTML_UPLOAD" && sourceType === "HTML_UPLOAD") fileInput.current?.click()
    else setSourceType(value)
  }
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
      {[["HTML_UPLOAD", "Upload HTML"], ["EXTERNAL_LINK", "External link"]].map(([value, label]) => <Button key={value} type="button" aria-pressed={sourceType === value} variant={sourceType === value ? "default" : "outline"} onClick={() => chooseSource(value)}>{label}</Button>)}
    </div>
    <input type="hidden" name="sourceType" value={sourceType} />
    <label className="block text-sm font-medium">Title<Input name="title" required maxLength={255} className="mt-1" /></label>
    <label className="block text-sm font-medium">Description<Textarea name="description" className="mt-1" /></label>
    {sourceType === "HTML_UPLOAD" ? <label className="block text-sm font-medium">Self-contained HTML file<Input ref={fileInput} name="file" type="file" accept=".html,text/html" required className="mt-1" /><span className="block mt-1 text-xs text-text-subtle">One .html file, up to 2 MB. Network access is blocked in preview.</span></label> : null}
    {sourceType === "HTML_UPLOAD" && <label className="flex items-start gap-2 text-sm"><Checkbox name="kind" value="SLIDE_DECK" className="mt-1" /><span><span className="font-medium">This is a slide deck</span><span className="block text-xs text-text-subtle">Show it one slide at a time, with feedback anchored to each slide.</span></span></label>}
    {sourceType === "HTML_UPLOAD" ? null : <label className="block text-sm font-medium">External URL<Input name="url" type="url" required placeholder="https://…" className="mt-1" /></label>}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
    <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create artifact"}</Button>
  </form>
}
