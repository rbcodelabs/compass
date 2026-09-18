import { auth } from "@/auth"
import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import Link from "next/link"
import { EntityCard } from "@/components/patterns/entity-card"
import { PageHeader } from "@/components/patterns/page-header"

export const metadata = {
  title: "Dashboard",
}

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/login")
  }

  const prisma = getPrisma()

  const membershipRows = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: {
      workspace: {
        include: { organization: true },
      },
    },
  })

  // `relationMode = "prisma"` means the database enforces no foreign keys and
  // no cascade deletes, so deleting a workspace (or an organization) leaves its
  // membership rows behind pointing at nothing. Prisma still types both
  // relations as non-nullable, so the `workspace.organization.slug` below would
  // throw on such a row and take the whole workspace picker down. A membership
  // that resolves to no workspace grants nothing and has nowhere to link to, so
  // dropping it is the whole of the correct behaviour here.
  const memberships = membershipRows.filter((row) => row.workspace?.organization)

  if (memberships.length === 0) {
    redirect("/onboarding")
  }

  if (memberships.length === 1) {
    const { workspace } = memberships[0]
    redirect(`/${workspace.organization.slug}/${workspace.slug}/okrs`)
  }

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6 max-w-4xl mx-auto w-full">
      <PageHeader title="Workspaces" description="Choose a workspace to continue." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {memberships.map(({ workspace }) => (
          <Link
            key={workspace.id}
            href={`/${workspace.organization.slug}/${workspace.slug}/okrs`}
          >
            <EntityCard
              title={workspace.name}
              eyebrow={workspace.organization.name}
              description={workspace.description}
              interactive
              className="h-full cursor-pointer"
            />
          </Link>
        ))}
      </div>
    </main>
  )
}
