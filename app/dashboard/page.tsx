import { auth } from "@/auth"
import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import Link from "next/link"

export const metadata = {
  title: "Dashboard",
}

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/login")
  }

  const prisma = getPrisma()

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: {
      workspace: {
        include: { organization: true },
      },
    },
  })

  if (memberships.length === 0) {
    redirect("/onboarding")
  }

  if (memberships.length === 1) {
    const { workspace } = memberships[0]
    redirect(`/${workspace.organization.slug}/${workspace.slug}/okrs`)
  }

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6 max-w-4xl mx-auto w-full">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
        <p className="text-slate-500 text-sm">Choose a workspace to continue.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {memberships.map(({ workspace }) => (
          <Link
            key={workspace.id}
            href={`/${workspace.organization.slug}/${workspace.slug}/okrs`}
          >
            <Card className="hover:border-slate-400 transition-colors cursor-pointer h-full">
              <CardHeader>
                <CardTitle className="text-base">{workspace.name}</CardTitle>
                <CardDescription>{workspace.organization.name}</CardDescription>
                {workspace.description && (
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">
                    {workspace.description}
                  </p>
                )}
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  )
}
