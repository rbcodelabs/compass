// Server component — runs auth() before any client code renders.
// force-dynamic prevents Vercel from statically caching this route,
// which would bypass middleware for unauthenticated visitors.
export const dynamic = "force-dynamic"

import { auth } from "@/auth"
import { redirect } from "next/navigation"

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user) {
    redirect("/login")
  }
  return <>{children}</>
}
