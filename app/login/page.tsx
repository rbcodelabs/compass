import { signIn } from "@/auth"
import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"

export const metadata = {
  title: "Sign in",
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
    <main className="flex min-h-screen items-center justify-center px-4 bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200">
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
            <span className="text-2xl font-bold tracking-tight text-slate-900">Compass</span>
            <p className="text-sm text-slate-500 mt-1">
              Product discovery, powered by outcomes.
            </p>
          </div>
        </div>

        {checkEmail ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center space-y-3 shadow-sm">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
              <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-semibold text-slate-900">Check your email</p>
            <p className="text-sm text-slate-500">
              We sent a sign-in link to your inbox. Click it to continue.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm space-y-6">
            <div className="space-y-1">
              <h1 className="text-lg font-bold text-slate-900">Sign in to Compass</h1>
              <p className="text-sm text-slate-500">
                Enter your email to receive a magic link.
              </p>
            </div>

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
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium text-slate-700">Email address</Label>
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
              </div>
              <Button type="submit" className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold shadow-sm">
                Send magic link
              </Button>
            </form>

            {/* Dev-only instant login — never shown in production */}
            {isDev && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-dashed border-amber-200" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-white px-2 text-amber-500 font-medium tracking-wide">dev only</span>
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
                    className="w-full h-11 border-amber-300 text-amber-700 hover:bg-amber-50 font-semibold"
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
