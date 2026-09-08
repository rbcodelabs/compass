"use client"

import { useState, useSyncExternalStore, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

const subscribeToHydration = () => () => {}
const clientReady = () => true
const serverReady = () => false

export function AnalysisButton({ studyId, sessionId, kind, children, regenerate }: { studyId: string; sessionId?: string; kind: "summary" | "coverage" | "synthesis"; children: ReactNode; regenerate?: boolean }) {
  const router = useRouter()
  // Server HTML must not offer an action before its client handler can run.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientReady, serverReady)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function generate() {
    if (!hydrated || pending) return
    setPending(true); setError(null)
    try {
      const response = await fetch("/api/research/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyId, sessionId, kind, regenerate }) })
      const body = await response.json()
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Analysis unavailable")
      router.refresh()
    } catch (error) { setError(error instanceof Error ? error.message : "Analysis unavailable") }
    finally { setPending(false) }
  }
  return <div className="space-y-2"><Button variant="outline" size="sm" disabled={!hydrated || pending} aria-busy={!hydrated || pending} onClick={generate}>{pending ? "Analyzing saved research…" : children}</Button>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
}
