"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import type { ApprovalActionResult } from "@/lib/tool-approval/messages"
import { cn } from "@/lib/utils"

type Action = "APPROVE" | "REJECT"

const newKey = (): string => `ta-${globalThis.crypto.randomUUID()}`

const TONE: Record<ApprovalActionResult["tone"], string> = {
  success: "text-status-success", info: "text-status-info", neutral: "text-text-secondary", warning: "text-status-warning", danger: "text-status-danger",
}

/**
 * Approve / Deny. One idempotency key per button per mounted instance, reused on every click of that button: a double click or a
 * retry after a dropped response replays the same decision instead of making a second one. Both buttons stay disabled while a
 * request is in flight and when `disabledReason` is set (a person who cannot decide sees why instead of a missing control).
 * Touch targets are 44px tall below `sm`.
 */
export function ApprovalActions({
  decide,
  disabledReason,
  onDecided,
  compact = false,
}: {
  decide: (action: Action, idempotencyKey: string) => Promise<ApprovalActionResult>
  disabledReason?: string
  onDecided?: (result: ApprovalActionResult) => void
  compact?: boolean
}) {
  const router = useRouter()
  const keys = useRef<Partial<Record<Action, string>>>({})
  const inFlight = useRef(false)
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ApprovalActionResult | null>(null)
  const disabled = pending || Boolean(disabledReason)

  const click = (action: Action) => {
    if (inFlight.current || disabledReason) return
    inFlight.current = true
    keys.current[action] ??= newKey()
    const key = keys.current[action]!
    startTransition(async () => {
      try {
        const outcome = await decide(action, key)
        setResult(outcome)
        onDecided?.(outcome)
        router.refresh()
      } catch {
        setResult({ ok: false, tone: "danger", message: "The request did not complete. Refresh to see the current status; an approval is never run twice." })
      } finally {
        inFlight.current = false
      }
    })
  }

  const size = compact ? "h-11 px-3 sm:h-8" : "h-11 px-4 sm:h-9"
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" className={size} disabled={disabled} onClick={() => click("APPROVE")} data-testid="approve-button">Approve</Button>
        <Button type="button" variant="destructive" className={size} disabled={disabled} onClick={() => click("REJECT")} data-testid="deny-button">Deny</Button>
      </div>
      {disabledReason && <p className="text-xs text-text-subtle" data-testid="approval-disabled-reason">{disabledReason}</p>}
      <p role="status" aria-live="polite" data-testid="approval-result" className={cn("text-sm break-words [overflow-wrap:anywhere]", result ? TONE[result.tone] : "sr-only")}>
        {pending ? "Working…" : result?.message ?? ""}
      </p>
    </div>
  )
}

/** Re-renders the server page every few seconds while an approval is still running, so it settles without a manual reload. */
export function RefreshWhile({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(timer)
  }, [active, everyMs, router])
  return null
}
