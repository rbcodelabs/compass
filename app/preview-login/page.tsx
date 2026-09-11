import { notFound } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { FormField } from "@/components/patterns/form-field"
import { isPreviewLoginEnabled } from "@/lib/preview-login"

export const metadata = {
  title: "Preview login",
}

// Without this, Next.js statically prerenders this page at build time (it
// has no other dynamic API calls), baking in whatever PREVIEW_LOGIN_ENABLED
// happened to resolve to at build time into the build output. That's a
// security-relevant gate — force it to be evaluated on every request
// instead, matching /login's own dynamic rendering.
export const dynamic = "force-dynamic"

export default function PreviewLoginPage() {
  // No DB access, no rendering of anything persona-related, on any
  // deployment where this isn't explicitly opted in — real Next.js 404,
  // identical to production or a preview branch without the flag set.
  if (!isPreviewLoginEnabled()) {
    notFound()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-app px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary shadow-[var(--shadow-panel)]">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-6 h-6"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
          </div>
          <div>
            <span className="text-2xl font-bold tracking-tight text-text-primary">Compass</span>
            <p className="mt-1 text-sm text-text-subtle">
              Preview login — pick a sample user to explore this deployment with seeded data. Sessions expire after 60 minutes.
            </p>
          </div>
        </div>

        <div className="space-y-6 rounded-2xl border border-border-default bg-surface-panel p-8 shadow-[var(--shadow-card)]">
          <div className="space-y-1">
            <h1 className="text-lg font-bold text-text-primary">Explore this preview</h1>
            <p className="text-sm text-text-subtle">
              Enter the access code for this deployment, then choose a sample user.
            </p>
          </div>

          <form method="POST" action="/api/preview-login/start" className="space-y-5">
            <FormField id="code" label="Access code" required>
              <Input
                id="code"
                name="code"
                type="password"
                placeholder="Access code"
                required
                autoComplete="off"
                autoFocus
                className="h-11"
              />
            </FormField>

            <div className="space-y-2">
              <Button
                type="submit"
                name="persona"
                value="owner"
                className="h-11 w-full flex-col items-start gap-0.5 whitespace-normal px-4 text-left font-semibold shadow-sm"
              >
                <span>Workspace Admin</span>
                <span className="text-xs font-normal opacity-80">Full admin permissions in the sample workspace.</span>
              </Button>
              <Button
                type="submit"
                name="persona"
                value="viewer"
                variant="outline"
                className="h-11 w-full flex-col items-start gap-0.5 whitespace-normal px-4 text-left font-semibold"
              >
                <span>Team Member</span>
                <span className="text-xs font-normal opacity-80">Workspace member permissions.</span>
              </Button>
              <p className="text-xs text-text-subtle">
                Compass does not yet enforce a strict read-only role, so a Team Member can still edit data in the sample workspace.
              </p>
            </div>
          </form>
        </div>
      </div>
    </main>
  )
}
