import { auth } from "@/auth"
import { redirect, notFound } from "next/navigation"
import { getWorkspace } from "@/lib/workspace"
import { Sidebar } from "@/components/sidebar"

interface WorkspaceLayoutProps {
  children: React.ReactNode
  params: Promise<{ orgSlug: string; workspaceSlug: string }>
}

export default async function WorkspaceLayout({
  children,
  params,
}: WorkspaceLayoutProps) {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/login")
  }

  const { orgSlug, workspaceSlug } = await params

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) {
    notFound()
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceName={workspace.name}
        userName={session.user.name ?? session.user.email ?? ""}
        userImage={session.user.image ?? undefined}
      />
      <main className="flex-1 overflow-y-auto bg-white">
        {children}
      </main>
    </div>
  )
}
