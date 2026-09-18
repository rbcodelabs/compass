"use client"

import { useState } from "react"
import Link from "next/link"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { deserializeResearchGuide } from "@/lib/research"
import { ResearchSubmitButton } from "@/components/research/research-submit-button"

type StudySettingsProps = {
  study: {
    name: string
    goal: string
    studyType: string
    guide: string
    targetMinutes: number
    appUrl: string | null
    artifactId?: string | null
  }
  protocolLocked: boolean
  action: (data: FormData) => void | Promise<void>
  /** Display-only: the artifact's title, resolved server-side. Never the artifact's other fields. */
  linkedArtifact?: { id: string; title: string } | null
  artifactHref?: string | null
}

export function StudySettings({ study, protocolLocked, action, linkedArtifact = null, artifactHref = null }: StudySettingsProps) {
  const [studyType, setStudyType] = useState(study.studyType)
  const guided = studyType === "USABILITY_TEST"
  const guide = deserializeResearchGuide(study.guide)
  // The target-mode toggle lives in the study builder at creation time. Here,
  // once a study is artifact-backed, settings shows that target read-only
  // (with a hidden field preserving it across a protocol update) rather than
  // re-litigating the appUrl/artifact choice on every save.
  const isArtifactTarget = Boolean(study.artifactId)

  return <section className="max-w-3xl rounded-xl border bg-surface-panel p-5">
    <h2 className="font-semibold">Study settings</h2>
    {protocolLocked && <p className="mt-1 text-sm text-text-muted">The protocol is locked because participant sessions have started. You can still rename this study.</p>}
    <form action={action} className="mt-4 space-y-4">
      <div className="space-y-2"><Label htmlFor="study-name">Study name</Label><Input defaultValue={study.name} id="study-name" name="name" required /></div>
      <fieldset disabled={protocolLocked} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="study-type">Study type</Label><select className="h-9 rounded-lg border bg-transparent px-3 text-sm" id="study-type" name="studyType" onChange={(event) => setStudyType(event.target.value)} value={studyType}><option value="CUSTOMER_INTERVIEW">Customer interview</option><option value="USABILITY_TEST">Guided usability test</option></select></div>
        <div className="space-y-2"><Label htmlFor="study-goal">Research goal</Label><Textarea defaultValue={study.goal} id="study-goal" name="goal" required /></div>
        {guided && (isArtifactTarget
          ? <div className="space-y-2">
            <Label>Prototype artifact</Label>
            <input name="artifactId" type="hidden" value={study.artifactId ?? ""} />
            {linkedArtifact && artifactHref
              ? <p className="text-sm"><Link className="font-medium underline" href={artifactHref}>{linkedArtifact.title}</Link></p>
              : <p className="text-sm text-text-subtle">The linked artifact is unavailable.</p>}
            <p className="text-xs text-text-muted">To target a different artifact or a live URL instead, create a new study.</p>
          </div>
          : <div className="space-y-2"><Label htmlFor="study-app-url">Live product URL</Label><Input defaultValue={study.appUrl ?? ""} id="study-app-url" name="appUrl" required type="url" /></div>)}
        <div className="space-y-2"><Label htmlFor="study-duration">Target duration</Label><select className="h-9 rounded-lg border bg-transparent px-3 text-sm" defaultValue={study.targetMinutes} id="study-duration" name="targetMinutes">{[10, 15, 20, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="study-guide">{guided ? "Task guide" : "Discussion guide"}</Label><Textarea aria-label={guided ? "Task guide" : "Discussion guide"} defaultValue={guide.map((item) => item.text).join("\n")} id="study-guide" name="guide" required rows={Math.max(5, guide.length)} /><p className="text-xs text-text-muted">Use one {guided ? "task" : "question"} per line.</p></div>
      </fieldset>
      <ResearchSubmitButton pendingLabel="Saving…">Save study</ResearchSubmitButton>
    </form>
  </section>
}
