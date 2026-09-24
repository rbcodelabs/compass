import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { PageHeader } from "@/components/patterns/page-header"
import { ProfileForm } from "@/components/settings/profile-form"

export const metadata = { title: "Profile" }

export default async function ProfilePage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  const profile = await getPrisma().user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!profile) redirect("/login")
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
    <Link href="/dashboard" className="text-sm text-text-subtle underline">Back to Compass</Link>
    <PageHeader title="Profile" description="Your name across Compass." />
    <ProfileForm name={profile.name} email={profile.email} />
  </main>
}
