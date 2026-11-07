import type { Metadata } from "next"
import Link from "next/link"
import { FileText } from "lucide-react"
import { notFound } from "next/navigation"
import getPrisma from "@/lib/db"
import { listPublishedDocs } from "@/lib/portal-docs/service"
import { formatDocDate, portalDocsPath } from "@/lib/portal-docs/format"
import { EmptyState } from "@/components/patterns/empty-state"
import { PageHeader } from "@/components/patterns/page-header"
import { DocBreadcrumb } from "@/components/portal-docs/doc-nav"

export const dynamic = "force-dynamic"

type Props = { params: Promise<{ orgSlug: string; workspaceSlug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, workspaceSlug } = await params
  const workspace = await getPrisma().workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug } }, select: { name: true } })
  return { title: workspace ? `Docs · ${workspace.name}` : "Docs" }
}

/** Public index of published docs (newest publish first). Only listPublishedDocs feeds it. */
export default async function PortalDocsIndexPage({ params }: Props) {
  const { orgSlug, workspaceSlug } = await params
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, name: true },
  })
  if (!workspace) notFound()
  const docs = await listPublishedDocs(prisma, workspace.id)
  const base = portalDocsPath(orgSlug, workspaceSlug)

  return (
    <div className="flex flex-col gap-6">
      <DocBreadcrumb items={[{ label: workspace.name, href: `/portal/${orgSlug}/${workspaceSlug}` }, { label: "Docs" }]} />
      <PageHeader title="Docs" description="Guides and references from the team." />
      {docs.length === 0 ? (
        <EmptyState icon={<FileText className="size-4" aria-hidden />} title="No docs published yet" description="Guides and references will appear here once they are published." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="portal-docs-index">
          {docs.map((doc) => (
            <li key={doc.id}>
              <Link
                href={`${base}/${doc.id}`}
                className="flex h-full flex-col gap-1.5 rounded-xl border border-border-default bg-surface-panel p-4 shadow-[var(--shadow-card)] transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <FileText className="size-4 shrink-0 text-text-subtle" aria-hidden />
                  <span className="min-w-0 truncate">{doc.title || "Untitled"}</span>
                </span>
                {doc.excerpt ? <span className="line-clamp-3 text-sm leading-6 text-text-secondary">{doc.excerpt}</span> : null}
                <span className="mt-auto pt-1 text-xs text-text-subtle">Updated {formatDocDate(doc.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
