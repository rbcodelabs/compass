"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { parseResearchGuide } from "@/lib/research"

type StudySettingsProps = {
  study: {
    name: string
    goal: string
    studyType: string
    guide: string
    targetMinutes: number
    appUrl: string | null
  }
  protocolLocked: boolean
  action: (data: FormData) => void | Promise<void>
}

export function StudySettings({ study, protocolLocked, action }: StudySettingsProps) {
  const [studyType, setStudyType] = useState(study.studyType)
  const guided = studyType === "USABILITY_TEST"
  const guide = parseResearchGuide(study.guide.startsWith("[")
    ? (JSON.parse(study.guide) as Array<{ text: string }>).map((item) => item.text)
    : study.guide)

  return <section className="max-w-3xl rounded-xl border bg-surface-panel p-5">
    <h2 className="font-semibold">Study settings</h2>
    {protocolLocked && <p className="mt-1 text-sm text-text-muted">The protocol is locked because participant sessions have started. You can still rename this study.</p>}
    <form action={action} className="mt-4 space-y-4">
      <div className="space-y-2"><Label htmlFor="study-name">Study name</Label><Input defaultValue={study.name} id="study-name" name="name" required /></div>
      <fieldset disabled={protocolLocked} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="study-type">Study type</Label><select className="h-9 rounded-lg border bg-transparent px-3 text-sm" id="study-type" name="studyType" onChange={(event) => setStudyType(event.target.value)} value={studyType}><option value="CUSTOMER_INTERVIEW">Customer interview</option><option value="USABILITY_TEST">Guided usability test</option></select></div>
        <div className="space-y-2"><Label htmlFor="study-goal">Research goal</Label><Textarea defaultValue={study.goal} id="study-goal" name="goal" required /></div>
        {guided && <div className="space-y-2"><Label htmlFor="study-app-url">Live product URL</Label><Input defaultValue={study.appUrl ?? ""} id="study-app-url" name="appUrl" required type="url" /></div>}
        <div className="space-y-2"><Label htmlFor="study-duration">Target duration</Label><select className="h-9 rounded-lg border bg-transparent px-3 text-sm" defaultValue={study.targetMinutes} id="study-duration" name="targetMinutes">{[10, 15, 20, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="study-guide">{guided ? "Task guide" : "Discussion guide"}</Label><Textarea aria-label={guided ? "Task guide" : "Discussion guide"} defaultValue={guide.map((item) => item.text).join("\n")} id="study-guide" name="guide" required rows={Math.max(5, guide.length)} /><p className="text-xs text-text-muted">Use one {guided ? "task" : "question"} per line.</p></div>
      </fieldset>
      <Button type="submit">Save study</Button>
    </form>
  </section>
}
