import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { PageHeader } from "@/components/patterns/page-header"
import { AgentSnapshotPanel } from "@/components/settings/agent-snapshot-panel"
import { getAgentSnapshotStatus } from "@/lib/agent-snapshot-admin"
import { isPlatformAdminSession } from "@/lib/platform-admin"

export const metadata = { title: "Agent snapshot" }
// The rebuild runs through /api/admin/agent-snapshot, which sets its own
// maxDuration; this page only reads status.
export const dynamic = "force-dynamic"

export default async function AgentSnapshotPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/login")
  // 404 rather than 403 so the page's existence isn't advertised to non-admins.
  if (!isPlatformAdminSession(session)) notFound()

  const status = await getAgentSnapshotStatus()
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <Link href="/dashboard" className="text-sm text-text-subtle underline">
        Back to Compass
      </Link>
      <PageHeader
        title="Agent snapshot"
        description="The golden Vercel Sandbox snapshot the in-app agent boots from. Rebuild it after changing the sandbox dependencies, system packages, or runtime."
      />
      <AgentSnapshotPanel
        initialStatus={{
          ...status,
          snapshotBuiltAt: status.snapshotBuiltAt ? status.snapshotBuiltAt.toISOString() : null,
        }}
      />
    </main>
  )
}
