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
  if (session) {
    redirect("/dashboard")
  }

  const params = await searchParams
  const checkEmail = params["check-email"] === "1"

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-5 h-5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
              </svg>
            </div>
            <span className="text-xl font-semibold tracking-tight">Compass</span>
          </div>
          <p className="text-sm text-slate-500">
            Product discovery, powered by outcomes.
          </p>
        </div>

        {checkEmail ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center space-y-2">
            <p className="font-medium text-slate-900">Check your email</p>
            <p className="text-sm text-slate-500">
              We sent a sign-in link to your inbox. Click it to continue.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm space-y-6">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
              <p className="text-sm text-slate-500">
                Enter your email to receive a magic link.
              </p>
            </div>

            <form
              action={async (formData: FormData) => {
                "use server"
                const email = formData.get("email") as string
                await signIn("resend", { email, redirectTo: "/dashboard" })
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="email">Email address</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full">
                Send magic link
              </Button>
            </form>
          </div>
        )}
      </div>
    </main>
  )
}
