import { auth } from "@/auth"
import { redirect } from "next/navigation"
import getPrisma from "@/lib/db"
import { getUserWorkspaces } from "@/lib/workspace"
import { WorkspaceGallery } from "@/components/workspace-selector/workspace-gallery"
import { ThemeProvider } from "@/components/theme/theme-provider"
import { workspaceThemeInitScript } from "@/lib/theme"

// The gallery lives outside the workspace layout, which is what normally
// applies the stored light/dark preference. Do the same here, before paint.
function Themed({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: workspaceThemeInitScript }} />
      <ThemeProvider>{children}</ThemeProvider>
    </>
  )
}

export const metadata = {
  title: "Dashboard",
}

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/login")
  }

  const userEmail = session.user.email ?? undefined
  const userName = session.user.name ?? userEmail ?? "there"

  const prisma = getPrisma()

  const membershipRows = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: {
      workspace: {
        include: { organization: true, _count: { select: { members: true } } },
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
      <Themed>
      <WorkspaceGallery
        userName={userName}
        userEmail={userEmail}
        workspaces={memberships.map(({ workspace }) => ({
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          orgSlug: workspace.organization.slug,
          orgName: workspace.organization.name,
          description: workspace.description,
          // Optional chaining: `_count` is only present on rows from the real query.
          memberCount: workspace._count?.members,
        }))}
      />
      </Themed>
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
    <Themed>
    <WorkspaceGallery
      userName={userName}
      userEmail={userEmail}
      readOnlyNotice
      workspaces={readOnlyWorkspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        orgSlug: workspace.orgSlug,
        orgName: workspace.orgName,
        description: workspace.description,
        memberCount: workspace.memberCount,
        isReadOnly: true,
      }))}
    />
    </Themed>
  )
}
