"use client"

import { useRef, useState, useTransition } from "react"
import { LoaderCircleIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

type Task = { id: number; text: string }

export function StudyBuilder({
  action,
  generateGuide,
}: {
  action: (data: FormData) => void | Promise<void>
  generateGuide: (input: { studyType: "CUSTOMER_INTERVIEW" | "USABILITY_TEST"; goal: string; appUrl: string; targetMinutes: number }) => Promise<string[]>
}) {
  const nextId = useRef(2)
  const [studyType, setStudyType] = useState<"CUSTOMER_INTERVIEW" | "USABILITY_TEST">("CUSTOMER_INTERVIEW")
  const [items, setItems] = useState<Task[]>([{ id: 1, text: "" }])
  const [goal, setGoal] = useState("")
  const [appUrl, setAppUrl] = useState("")
  const [targetMinutes, setTargetMinutes] = useState(15)
  const [error, setError] = useState<string | null>(null)
  const [generating, startGenerating] = useTransition()
  const guided = studyType === "USABILITY_TEST"

  function addItem() {
    setItems((current) => [...current, { id: nextId.current++, text: "" }])
  }

  function removeItem(id: number) {
    setItems((current) => current.filter((item) => item.id !== id))
  }

  function updateItem(id: number, text: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, text } : item))
  }

  function generate() {
    setError(null)
    startGenerating(async () => {
      try {
        const tasks = await generateGuide({ studyType, goal, appUrl, targetMinutes })
        setItems(tasks.map((text) => ({ id: nextId.current++, text })))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Compass could not generate a study guide")
      }
    })
  }

  return (
    <form action={action} className="max-w-2xl space-y-6 rounded-xl border bg-surface-panel p-4 sm:p-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Study type</legend>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
          <input
            aria-label="Customer interview"
            checked={!guided}
            name="studyType"
            onChange={() => setStudyType("CUSTOMER_INTERVIEW")}
            type="radio"
            value="CUSTOMER_INTERVIEW"
          />
          <span><span className="block text-sm font-medium">Customer interview</span><span className="text-sm text-text-muted">Explore needs, habits, and past experiences.</span></span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
          <input
            aria-label="Guided usability test"
            checked={guided}
            name="studyType"
            onChange={() => setStudyType("USABILITY_TEST")}
            type="radio"
            value="USABILITY_TEST"
          />
          <span><span className="block text-sm font-medium">Guided usability test</span><span className="text-sm text-text-muted">Watch people work through realistic goals in a live product using chat or voice.</span></span>
        </label>
      </fieldset>

      <div className="space-y-2"><Label htmlFor="name">Study name</Label><Input id="name" name="name" required /></div>
      <div className="space-y-2"><Label htmlFor="goal">What are you trying to learn?</Label><Textarea id="goal" name="goal" onChange={(event) => setGoal(event.target.value)} required value={goal} /></div>

      {guided &&
        <div className="space-y-2">
          <Label htmlFor="appUrl">Live product URL</Label>
          <Input id="appUrl" name="appUrl" onChange={(event) => setAppUrl(event.target.value)} placeholder="https://app.example.com" required type="url" value={appUrl} />
          <p className="text-sm text-text-muted">Compass never fetches this URL. Participants can open it beside the moderator or in a separate tab.</p>
        </div>
      }
      <div className="space-y-2">
        <Label htmlFor="targetMinutes">Target duration</Label>
        <select className="h-9 rounded-lg border bg-transparent px-3 text-sm" id="targetMinutes" name="targetMinutes" onChange={(event) => setTargetMinutes(Number(event.target.value))} value={targetMinutes}>
          {[10, 15, 20, 30].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
        </select>
      </div>
      <Button disabled={generating} onClick={generate} type="button" variant="outline">
        {generating ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
        {generating ? `Generating ${guided ? "tasks" : "questions"}…` : `Generate ${guided ? "tasks" : "questions"} with Compass`}
      </Button>

      <fieldset className="space-y-3">
        <div className="space-y-1">
          <legend className="text-sm font-medium">{guided ? "Task guide" : "Discussion guide"}</legend>
          <p className="text-sm text-text-muted">{guided ? "Generate 5–8 editable tasks, then refine, add, or remove them before creating the study." : "Add what you want Compass to cover. It will ask these one at a time and follow up naturally."}</p>
        </div>
        <div className="space-y-2">
          {items.map((item, index) => <div className="flex items-center gap-2" key={item.id}>
            <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-text-muted">{index + 1}</span>
            <Input aria-label={`${guided ? "Task" : "Question"} ${index + 1}`} name="guide" onChange={(event) => updateItem(item.id, event.target.value)} placeholder={guided ? "Describe a realistic outcome…" : "Tell me about the last time you…"} required value={item.text} />
            <Button aria-label={`Remove ${guided ? "task" : "question"} ${index + 1}`} disabled={items.length === 1} onClick={() => removeItem(item.id)} size="icon" type="button" variant="ghost"><Trash2Icon /></Button>
          </div>)}
        </div>
        <Button onClick={addItem} type="button" variant="outline"><PlusIcon data-icon="inline-start" />Add {guided ? "task" : "question"}</Button>
      </fieldset>
      {error && <p aria-live="polite" className="text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit">Create and activate study</Button>
    </form>
  )
}
