"use client"

import { useEffect, useState } from "react"
import { ExternalLinkIcon, MessageSquareIcon, MicIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ResearchChat } from "@/components/research/research-chat"
import { ResearchVoice } from "@/components/research/research-voice"

export function ResearchExperience({
  token,
  studyName,
  studyType,
  appUrl,
}: {
  token: string
  studyName: string
  studyType: "CUSTOMER_INTERVIEW" | "USABILITY_TEST"
  appUrl: string | null
}) {
  const [modality, setModality] = useState<"CHAT" | "VOICE" | null>(null)
  const modalityStorageKey = `compass-research-modality-${token.slice(-16)}`
  useEffect(() => {
    if (studyType !== "USABILITY_TEST" || !appUrl) return
    const restoreTimer = window.setTimeout(() => {
      const stored = localStorage.getItem(modalityStorageKey)
      if (stored === "CHAT" || stored === "VOICE") setModality(stored)
    }, 0)
    return () => window.clearTimeout(restoreTimer)
  }, [appUrl, modalityStorageKey, studyType])

  function chooseModality(next: "CHAT" | "VOICE") {
    localStorage.setItem(modalityStorageKey, next)
    setModality(next)
  }
  if (studyType !== "USABILITY_TEST" || !appUrl) return <ResearchChat token={token} />

  if (!modality) {
    return <section className="mx-auto max-w-xl rounded-xl border bg-surface-panel p-6 sm:p-8">
      <h2 className="text-lg font-semibold">Choose how you’d like to participate</h2>
      <p className="mt-2 text-sm leading-relaxed text-text-subtle">
        You’ll use a live product while Compass guides you through realistic tasks. Please think aloud—say what you notice, expect, and find confusing. We’re testing the product, not you.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Button className="h-auto justify-start p-4" onClick={() => chooseModality("CHAT")} variant="outline">
          <MessageSquareIcon />
          <span className="text-left"><span className="block font-medium">Use chat</span><span className="block text-xs text-text-muted">Type while you work</span></span>
        </Button>
        <Button className="h-auto justify-start p-4" onClick={() => chooseModality("VOICE")} variant="outline">
          <MicIcon />
          <span className="text-left"><span className="block font-medium">Use voice</span><span className="block text-xs text-text-muted">Talk naturally while you work</span></span>
        </Button>
      </div>
    </section>
  }

  return <div className="flex min-h-[70vh] flex-col rounded-xl border bg-surface-panel lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)] lg:overflow-hidden">
    <section className="flex min-h-[22rem] flex-col border-b lg:min-h-0 lg:border-r lg:border-b-0">
      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b bg-surface-panel px-4 py-3 lg:static">
        <div><h2 className="text-sm font-medium">Live product</h2><p className="text-xs text-text-muted">If the product does not appear below, open it separately.</p></div>
        <a className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary hover:underline" href={appUrl} rel="noopener noreferrer" target="_blank">
          Open product <ExternalLinkIcon className="size-4" />
        </a>
      </div>
      <iframe
        className="min-h-[20rem] flex-1 bg-background"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-popups"
        src={appUrl}
        title={`Live product for ${studyName}`}
      />
    </section>
    <section className="flex min-h-[32rem] flex-col p-4 sm:p-5 lg:min-h-0">
      {modality === "CHAT"
        ? <ResearchChat guided token={token} />
        : <ResearchVoice token={token} />}
    </section>
  </div>
}
