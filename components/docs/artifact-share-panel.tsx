"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  changeArtifactSharePasswordAction,
  enableArtifactShareAction,
  revokeArtifactShareAction,
  rotateArtifactShareLinkAction,
  setArtifactShareCommentsAction,
  type ShareActionResult,
} from "@/app/[orgSlug]/[workspaceSlug]/docs/actions"
import type { OwnerShareState } from "@/lib/artifact-share"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const EVENT_LABELS: Record<string, string> = {
  ENABLED: "Sharing turned on",
  PASSWORD_CHANGED: "Password changed",
  LINK_ROTATED: "Link replaced",
  COMMENTS_ENABLED: "Outside comments turned on",
  COMMENTS_DISABLED: "Outside comments turned off",
  REVOKED: "Sharing turned off",
}

type Props = { workspaceId: string; artifactId: string; basePath: string; state: OwnerShareState }

/**
 * Owner controls for the external share. The link and any generated password are held in
 * component state only: the server keeps a hash of each, so after this panel unmounts they
 * cannot be shown again (rotate / change instead).
 */
export function ArtifactSharePanel({ workspaceId, artifactId, basePath, state }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [password, setPassword] = useState("")
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)

  const run = (fn: () => Promise<ShareActionResult>, after?: (result: ShareActionResult) => void) =>
    startTransition(async () => {
      setError(null)
      setCopied(false)
      try {
        const result = await fn()
        if (result.error) { setError(result.error); return }
        after?.(result)
        router.refresh()
      } catch {
        setError("Action failed. Try again.")
      }
    })

  const showToken = (result: ShareActionResult) => {
    if (result.rawToken) setLink(`${window.location.origin}/s/${result.rawToken}`)
    setRevealedPassword(result.password ?? null)
  }
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(true) } catch { setError("Couldn't copy. Select the text and copy it manually.") }
  }

  return <section className="space-y-3 rounded-lg border p-4" aria-labelledby="artifact-share-heading">
    <div>
      <h2 id="artifact-share-heading" className="font-semibold">Share with people outside Compass</h2>
      <p className="text-xs text-muted-foreground">Anyone with the link and the password can view this artifact. They cannot see your internal comments.</p>
    </div>

    {!state.enabled ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); run(() => enableArtifactShareAction(workspaceId, artifactId, password.trim() === "" ? null : password, basePath), (result) => { showToken(result); setPassword("") }) }}>
      <label className="block text-sm" htmlFor="share-password">Password (leave blank to generate one)</label>
      <Input id="share-password" type="text" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" />
      <Button type="submit" disabled={pending}>{pending ? "Turning on…" : "Turn on sharing"}</Button>
    </form> : <div className="space-y-3">
      {link ? <div className="space-y-2 rounded-md bg-surface-panel p-3 text-sm" role="status">
        <p className="font-medium">Copy these now — the link can&apos;t be shown again.</p>
        <div className="flex gap-2"><Input readOnly aria-label="Share link" value={link} onFocus={(event) => event.currentTarget.select()} /><Button type="button" variant="outline" onClick={() => copy(link)}>{copied ? "Copied" : "Copy link"}</Button></div>
        {revealedPassword && <div className="flex gap-2"><Input readOnly aria-label="Generated password" value={revealedPassword} onFocus={(event) => event.currentTarget.select()} /><Button type="button" variant="outline" onClick={() => copy(revealedPassword)}>Copy password</Button></div>}
        <p className="text-xs text-muted-foreground">Send the link and the password through separate channels.</p>
      </div> : <p className="text-sm text-text-subtle">Sharing is on{state.enabledAt ? ` since ${new Date(state.enabledAt).toLocaleString()}` : ""}. The link is only shown when it&apos;s created; replace it to get a new one.</p>}

      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); run(() => changeArtifactSharePasswordAction(workspaceId, artifactId, password.trim() === "" ? null : password, basePath), (result) => { setRevealedPassword(result.password ?? null); setLink(null); setPassword("") }) }}>
        <div className="min-w-48 flex-1"><label className="block text-sm" htmlFor="share-new-password">New password (blank generates one)</label><Input id="share-new-password" type="text" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" /></div>
        <Button type="submit" variant="outline" disabled={pending}>Change password</Button>
      </form>
      {!link && revealedPassword && <div className="flex gap-2 text-sm" role="status"><Input readOnly aria-label="Generated password" value={revealedPassword} onFocus={(event) => event.currentTarget.select()} /><Button type="button" variant="outline" onClick={() => copy(revealedPassword)}>{copied ? "Copied" : "Copy password"}</Button></div>}
      <p className="text-xs text-muted-foreground">Changing the password or replacing the link signs everyone out.</p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => run(() => rotateArtifactShareLinkAction(workspaceId, artifactId, basePath), (result) => { showToken(result); setRevealedPassword(null) })}>Replace link</Button>
        {confirmingRevoke
          ? <><Button type="button" variant="destructive" disabled={pending} onClick={() => run(() => revokeArtifactShareAction(workspaceId, artifactId, basePath), () => { setLink(null); setRevealedPassword(null); setConfirmingRevoke(false) })}>Confirm: turn off sharing</Button><Button type="button" variant="ghost" onClick={() => setConfirmingRevoke(false)}>Cancel</Button></>
          : <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmingRevoke(true)}>Turn off sharing</Button>}
      </div>

      <div className="space-y-1 border-t pt-3">
        <div className="flex items-center gap-2 text-sm">
          <Checkbox id={`share-comments-${artifactId}`} checked={state.commentsEnabled} disabled={pending || !state.commentingAvailable} onCheckedChange={(checked) => run(() => setArtifactShareCommentsAction(workspaceId, artifactId, checked === true, basePath))} />
          <Label htmlFor={`share-comments-${artifactId}`}>Let viewers leave feedback (they verify by email)</Label>
        </div>
        {state.commentingAvailable
          ? <p className="text-xs text-muted-foreground">Viewers only ever see their own comments, never yours or anyone else&apos;s.</p>
          : <p className="text-xs text-muted-foreground">Unavailable: this deployment has no email provider configured, so viewers can&apos;t verify an address.</p>}
      </div>

      {state.events.length > 0 && <Collapsible className="text-sm"><CollapsibleTrigger className="cursor-pointer text-text-subtle">Activity</CollapsibleTrigger><CollapsibleContent><ul className="mt-2 space-y-1">{state.events.map((event) => <li key={event.id} className="flex justify-between gap-2"><span>{EVENT_LABELS[event.eventType] ?? event.eventType}</span><time className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</time></li>)}</ul></CollapsibleContent></Collapsible>}
    </div>}
    {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
  </section>
}
