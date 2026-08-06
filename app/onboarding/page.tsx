import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { signOutAction } from "@/lib/actions/auth-actions"
import { OnboardingForm } from "./onboarding-form"

export default async function OnboardingPage() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/login")
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-app px-4">
      <div className="w-full max-w-md space-y-4">
        {/* Identity banner — this page has no sidebar/header, so it's the only
            place a user lands before a workspace exists that shows which
            account they're signed in as. */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border-default bg-surface-panel px-4 py-2.5 text-sm shadow-[var(--shadow-card)]">
          <span className="truncate text-text-secondary">
            Signed in as{" "}
            <span className="font-medium text-text-primary">{session.user.email}</span>
          </span>
          <form action={signOutAction} className="shrink-0">
            <button
              type="submit"
              className="text-xs font-medium text-text-subtle hover:text-text-primary hover:underline"
            >
              Not you? Sign out
            </button>
          </form>
        </div>

        <OnboardingForm />
      </div>
    </main>
  )
}
