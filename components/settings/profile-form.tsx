"use client"

import { useState, useTransition } from "react"
import { saveProfile } from "@/app/settings/profile/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsSection } from "@/components/patterns/settings-section"

export function ProfileForm({ name, email }: { name: string | null; email: string }) {
  const [displayName, setDisplayName] = useState(name ?? "")
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  return <SettingsSection title="Personal information" description="Your profile is shared across your workspaces.">
    <form className="flex flex-col gap-5" onSubmit={event => {
      event.preventDefault()
      setMessage(null)
      startTransition(async () => {
        try {
          const result = await saveProfile(displayName)
          setMessage({ ok: result.ok, text: result.ok ? "Profile saved." : result.error })
          if (result.ok) setDisplayName(displayName.trim())
        } catch {
          setMessage({ ok: false, text: "Your profile could not be saved. Please try again." })
        }
      })
    }}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-email">Email</Label>
        <Input id="profile-email" type="email" value={email} readOnly aria-describedby="profile-email-hint" />
        <p id="profile-email-hint" className="text-sm text-text-subtle">Your sign-in email cannot be changed here.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-name">Display name</Label>
        <Input id="profile-name" autoComplete="name" value={displayName} onChange={event => { setDisplayName(event.target.value); setMessage(null) }} required maxLength={120} disabled={pending} aria-describedby="profile-name-hint" />
        <p id="profile-name-hint" className="text-sm text-text-subtle">Shown on your past and future comments. Until you set a name, your email is shown.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
        {message && <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-status-success" : "text-sm text-status-danger"}>{message.text}</p>}
      </div>
    </form>
  </SettingsSection>
}
