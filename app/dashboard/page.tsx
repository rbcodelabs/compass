import { auth } from "@/auth"
import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { getUserWorkspaces } from "@/lib/workspace"
import Link from "next/link"
import { EntityCard } from "@/components/patterns/entity-card"
import { PageHeader } from "@/components/patterns/page-header"

export const metadata = {
  title: "Dashboard",
}

/** Matches the badge style in components/sidebar.tsx's workspace switcher. */
function ReadOnlyChip() {
  return (
    <span className="rounded border border-border-default px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
      Read-only
    </span>
  )
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

  if (memberships.length === 1) {
    const { workspace } = memberships[0]
    redirect(`/${workspace.organization.slug}/${workspace.slug}/okrs`)
  }

  if (memberships.length > 1) {
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

  // No real WorkspaceMember row anywhere. Before concluding this user belongs
  // nowhere and sending them to onboarding, check whether any organization
  // they belong to grants implicit read-only access to its workspaces
  // (Organization.memberWorkspaceReadOnlyAccess -- see lib/workspace.ts).
  // Reuses getUserWorkspaces() rather than re-deriving the fallback query here,
  // so this and the sidebar switcher can never disagree about who counts as
  // having read-only access to what.
  const readOnlyWorkspaces = (await getUserWorkspaces(session.user.id)).filter((w) => w.isReadOnly)

  if (readOnlyWorkspaces.length === 0) {
    redirect("/onboarding")
  }

  if (readOnlyWorkspaces.length === 1) {
    const workspace = readOnlyWorkspaces[0]
    redirect(`/${workspace.orgSlug}/${workspace.slug}/okrs`)
  }

  return (
    <main className="flex flex-col flex-1 p-4 sm:p-6 md:p-8 gap-6 max-w-4xl mx-auto w-full">
      <PageHeader
        title="Workspaces"
        description="You have read-only access to these workspaces through your organization. Choose one to continue."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {readOnlyWorkspaces.map((workspace) => (
          <Link key={workspace.id} href={`/${workspace.orgSlug}/${workspace.slug}/okrs`}>
            <EntityCard
              title={workspace.name}
              eyebrow={workspace.orgName}
              status={<ReadOnlyChip />}
              interactive
              className="h-full cursor-pointer"
            />
          </Link>
        ))}
      </div>
    </main>
  )
}
