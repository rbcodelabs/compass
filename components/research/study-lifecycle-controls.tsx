"use client"

import { ResearchSubmitButton } from "@/components/research/research-submit-button"

export function StudyLifecycleControls({ status, activate, close, archive }: {
  status: string
  activate: () => void | Promise<void>
  close: () => void | Promise<void>
  archive: () => void | Promise<void>
}) {
  return <section className="flex max-w-3xl flex-wrap gap-2 rounded-xl border bg-surface-panel p-5">
    {status !== "ACTIVE" && status !== "ARCHIVED" && <form action={activate}><ResearchSubmitButton pendingLabel="Activating…">Activate study</ResearchSubmitButton></form>}
    {status === "ACTIVE" && <form action={close}><ResearchSubmitButton pendingLabel="Closing…" variant="outline">Close study</ResearchSubmitButton></form>}
    {status !== "ARCHIVED" && <form action={archive} onSubmit={(event) => { if (!window.confirm("Archive this study? Its research record will remain available by direct link.")) event.preventDefault() }}><ResearchSubmitButton pendingLabel="Archiving…" variant="ghost">Archive study</ResearchSubmitButton></form>}
  </section>
}
