"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsSection } from "@/components/patterns/settings-section"
import type { DeletionBlocker, DeletionPlan } from "@/lib/account-deletion"

function blockerText(blocker: DeletionBlocker) {
  if (blocker.kind === "ORGANIZATION_SOLE_OWNER") {
    return {
      key: `org-${blocker.organization.slug}`,
      text: `You are the only owner of the organization "${blocker.organization.name}", which other people still belong to. Make someone else an owner first.`,
      href: `/${blocker.organization.slug}/settings`,
    }
  }
  return {
    key: `ws-${blocker.workspace.orgSlug}-${blocker.workspace.slug}`,
    text: `Once you are gone, nobody would be able to administer the workspace "${blocker.workspace.name}", which other people can still reach. Make someone else a workspace administrator (or an organization owner or admin) first, or delete the workspace.`,
    href: `/${blocker.workspace.orgSlug}/${blocker.workspace.slug}/settings`,
  }
}

export function DeleteAccountPanel({ email, plan }: { email: string; plan: DeletionPlan }) {
  const router = useRouter()
  const [confirmEmail, setConfirmEmail] = useState("")
  const [deleteSoleOwned, setDeleteSoleOwned] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const blocked = plan.blockers.length > 0
  const soleOwnedCount = plan.soleOwned.organizations.length
  const needsSoleOwnedConsent = soleOwnedCount > 0
  const emailMatches = confirmEmail.trim().toLowerCase() === email.trim().toLowerCase()
  const canDelete = !blocked && emailMatches && (!needsSoleOwnedConsent || deleteSoleOwned) && !pending

  function submit() {
    if (!canDelete) return
    setError(null)
    startTransition(async () => {
      try {
        const response = await fetch("/api/account", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmEmail, soleOwnedOrganizationIds: deleteSoleOwned ? plan.soleOwned.organizations.map((org) => org.id) : [] }),
        })
        if (response.ok) {
          // The session is gone server-side: go to the public home page and drop cached authenticated pages.
          router.replace("/")
          router.refresh()
          return
        }
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        setError(
          response.status === 409
            ? "Your teams changed since this page loaded, so your account was not deleted. Reload this page to review what would be removed."
            : (body?.error ?? "Your account could not be deleted. Please try again."),
        )
      } catch {
        setError("Your account could not be deleted. Check your connection and try again.")
      }
    })
  }

  return (
    <SettingsSection
      danger
      title="Delete account"
      description="Permanently delete your Compass account and personal data. This cannot be undone."
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 text-sm leading-6 text-text-secondary">
          <p className="font-medium text-text-primary">What happens when you delete your account</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Your sign-in is removed: sessions, passkeys, and the tokens saved when you signed in with Google. We ask
              Google to revoke those tokens, and any Google Drive connection, before deleting them (revocation is best
              effort).
            </li>
            <li>
              Your agent conversations are deleted, including their messages, run records and saved transcripts, as are
              your API keys, personal agents, notifications and workspace memberships.
            </li>
            <li>
              Content you added to shared workspaces, such as documents, tasks, comments and roadmap items, stays with
              your teammates. It is no longer linked to you, and your name on comments is replaced with &quot;Deleted
              user&quot;.
            </li>
          </ul>
        </div>

        {blocked && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-status-danger/30 bg-status-danger-surface px-4 py-3 text-sm text-status-danger">
            <p className="font-medium">Before you can delete your account</p>
            <ul className="list-disc space-y-1 pl-5">
              {plan.blockers.map((blocker) => {
                const item = blockerText(blocker)
                return (
                  <li key={item.key}>
                    {item.text}{" "}
                    <Link href={item.href} className="underline">
                      Open settings
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {needsSoleOwnedConsent && (
          <div className="flex flex-col gap-3 rounded-lg border border-border-default px-4 py-3 text-sm">
            <p className="font-medium text-text-primary">Only you belong to these organizations, so they would be deleted too</p>
            <ul className="list-disc space-y-1 pl-5 text-text-secondary">
              {plan.soleOwned.organizations.map((org) => (
                <li key={org.id}>
                  Organization <strong>{org.name}</strong>
                  {org.workspaceNames.length > 0 && <> and its workspaces ({org.workspaceNames.join(", ")})</>}
                </li>
              ))}
            </ul>
            <div className="flex items-start gap-2 text-text-primary">
              <Checkbox
                id="delete-account-sole-owned"
                className="mt-1"
                checked={deleteSoleOwned}
                onCheckedChange={(checked) => setDeleteSoleOwned(checked === true)}
                disabled={pending}
              />
              <Label htmlFor="delete-account-sole-owned" className="font-normal">
                I understand these organizations will be permanently deleted along with all of their data.
              </Label>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="delete-account-email">
            Type <span className="font-mono font-semibold">{email}</span> to confirm
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="delete-account-email"
              type="email"
              autoComplete="off"
              value={confirmEmail}
              onChange={(event) => {
                setConfirmEmail(event.target.value)
                setError(null)
              }}
              placeholder={email}
              disabled={pending || blocked}
              className="sm:max-w-sm"
            />
            <Button type="button" variant="destructive" disabled={!canDelete} onClick={submit} className="shrink-0">
              {pending ? "Deleting…" : "Delete my account"}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm font-medium text-status-danger">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}
