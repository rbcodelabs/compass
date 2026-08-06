import { signIn } from "@/auth"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { FormField } from "@/components/patterns/form-field"

export const metadata = {
  title: "Sign in",
}

function GoogleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

interface LoginPageProps {
  searchParams: Promise<{ "check-email"?: string }>
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth()
  // Only redirect if the session is fully resolved (user.id present).
  // A session object without user.id means the DB lookup failed (e.g. wrong
  // schema in preview env) — fall through and show the login form instead.
  if (session?.user?.id) {
    redirect("/dashboard")
  }

  const params = await searchParams
  const checkEmail = params["check-email"] === "1"
  const isDev = process.env.NODE_ENV === "development"

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-app px-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
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
              Product discovery, powered by outcomes.
            </p>
          </div>
        </div>

        {checkEmail ? (
          <div className="space-y-3 rounded-2xl border border-border-default bg-surface-panel p-8 text-center shadow-[var(--shadow-card)]">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-status-success-surface">
              <svg className="h-5 w-5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-semibold text-text-primary">Check your email</p>
            <p className="text-sm text-text-subtle">
              We sent a sign-in link to your inbox. Click it to continue.
            </p>
          </div>
        ) : (
          <div className="space-y-6 rounded-2xl border border-border-default bg-surface-panel p-8 shadow-[var(--shadow-card)]">
            <div className="space-y-1">
              <h1 className="text-lg font-bold text-text-primary">Sign in to Compass</h1>
              <p className="text-sm text-text-subtle">
                Enter your email to receive a magic link.
              </p>
            </div>

            {/* Google sign-in — production only; dev mode has no Google provider registered */}
            {!isDev && (
              <>
                <form
                  action={async () => {
                    "use server"
                    await signIn("google", { callbackUrl: "/dashboard" })
                  }}
                >
                  <Button
                    type="submit"
                    variant="outline"
                    className="w-full h-11 gap-2 font-semibold"
                  >
                    <GoogleIcon />
                    Continue with Google
                  </Button>
                </form>

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border-default" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-surface-panel px-2 font-medium tracking-wide text-text-subtle">or</span>
                  </div>
                </div>
              </>
            )}

            <form
              action={async (formData: FormData) => {
                "use server"
                const email = formData.get("email") as string
                // redirect: false lets us control the post-submission redirect.
                // Without it, Auth.js redirects through /api/auth/verify-request
                // which strips the ?check-email=1 query param from our custom page.
                await signIn("resend", { email, redirect: false })
                redirect("/login?check-email=1")
              }}
              className="space-y-4"
            >
              <FormField id="email" label="Email address" required>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                  autoFocus
                  className="h-11"
                />
              </FormField>
              <Button type="submit" className="h-11 w-full font-semibold shadow-sm">
                Send magic link
              </Button>
            </form>

            {/* Dev-only instant login — never shown in production */}
            {isDev && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-dashed border-status-warning/30" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-surface-panel px-2 font-medium tracking-wide text-status-warning">dev only</span>
                  </div>
                </div>
                <form
                  action={async () => {
                    "use server"
                    // Use the dev-credentials provider — no token, no email, instant session.
                    await signIn("dev-credentials", {
                      email: "dev@localhost.dev",
                      redirectTo: "/dashboard",
                    })
                  }}
                >
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-11 w-full border-status-warning/40 font-semibold text-status-warning hover:bg-status-warning-surface"
                  >
                    ⚡ Dev Login
                  </Button>
                </form>
              </>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
