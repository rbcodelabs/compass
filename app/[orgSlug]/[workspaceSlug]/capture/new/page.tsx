import { PageHeader } from "@/components/patterns/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createResearchStudy } from "../actions"

export default async function NewStudyPage({ params }: { params: Promise<{ orgSlug: string; workspaceSlug: string }> }) {
  const { orgSlug, workspaceSlug } = await params
  const action = createResearchStudy.bind(null, orgSlug, workspaceSlug)
  return <main className="flex flex-1 flex-col gap-6 p-4 sm:p-6 md:p-8"><PageHeader title="New research study" description="Create a shareable customer interview." /><form action={action} className="max-w-2xl space-y-5 rounded-xl border bg-surface-panel p-6"><div className="space-y-2"><Label htmlFor="name">Study name</Label><Input id="name" name="name" required /></div><div className="space-y-2"><Label htmlFor="goal">What are you trying to learn?</Label><Textarea id="goal" name="goal" required /></div><div className="space-y-2"><Label htmlFor="guide">Discussion guide</Label><Textarea id="guide" name="guide" rows={8} required placeholder={'One question per line\nTell me about the last time you…'} /><p className="text-xs text-text-muted">Enter one open-ended question per line.</p></div><Button type="submit">Create study</Button></form></main>
}
