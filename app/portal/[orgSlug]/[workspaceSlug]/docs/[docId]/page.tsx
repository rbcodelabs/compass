import type { Metadata } from "next"
import { notFound } from "next/navigation"
import getPrisma from "@/lib/db"
import { getPublishedDoc, listPublishedDocs } from "@/lib/portal-docs/service"
import { formatDocDate, portalDocsPath, stripLeadingTitle } from "@/lib/portal-docs/format"
import { MarkdownContent } from "@/components/markdown-content"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DocBreadcrumb, DocNavList } from "@/components/portal-docs/doc-nav"

export const dynamic = "force-dynamic"

type Props = { params: Promise<{ orgSlug: string; workspaceSlug: string; docId: string }> }

/** Workspace by slugs. The workspace id is the scope every public doc read is bound to. */
async function loadWorkspace(orgSlug: string, workspaceSlug: string) {
  return getPrisma().workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, name: true },
  })
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug, workspaceSlug, docId } = await params
  const workspace = await loadWorkspace(orgSlug, workspaceSlug)
  const doc = workspace ? await getPublishedDoc(getPrisma(), workspace.id, docId) : null
  // An unpublished doc's title must not leak through the tab title either.
  return { title: doc ? `${doc.title || "Untitled"} · ${workspace?.name ?? "Docs"}` : "Doc not found" }
}

/**
 * Public, read-only published doc. Reads go through getPublishedDoc / listPublishedDocs ONLY: those carry the
 * workspace + publishedAt predicate, so an unpublished doc, a doc of another workspace and a malformed id all
 * render the same 404. Markdown is rendered by the shared MarkdownContent (react-markdown, no raw HTML, images
 * dropped, unsafe URL schemes stripped).
 */
export default async function PortalDocPage({ params }: Props) {
  const { orgSlug, workspaceSlug, docId } = await params
  const workspace = await loadWorkspace(orgSlug, workspaceSlug)
  if (!workspace) notFound()
  const prisma = getPrisma()
  const [doc, docs] = await Promise.all([getPublishedDoc(prisma, workspace.id, docId), listPublishedDocs(prisma, workspace.id, { limit: 50 })])
  if (!doc) notFound()

  const portalBase = `/portal/${orgSlug}/${workspaceSlug}`
  const docsBase = portalDocsPath(orgSlug, workspaceSlug)
  const others = docs.filter((candidate) => candidate.id !== doc.id)

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="min-w-0 lg:order-1" aria-labelledby="portal-doc-title" data-testid="portal-doc-article">
        <DocBreadcrumb items={[{ label: workspace.name, href: portalBase }, { label: "Docs", href: docsBase }, { label: doc.title || "Untitled" }]} />
        <header className="mt-4 border-b border-border-default pb-5">
          <h1 id="portal-doc-title" className="text-3xl font-bold leading-tight tracking-tight text-text-primary">{doc.title || "Untitled"}</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-text-subtle">
            <span>Published {formatDocDate(doc.publishedAt)}</span>
            {doc.updatedAt.slice(0, 10) !== doc.publishedAt.slice(0, 10) ? (
              <>
                <span aria-hidden>·</span>
                <span>Updated {formatDocDate(doc.updatedAt)}</span>
              </>
            ) : null}
          </p>
        </header>
        <MarkdownContent
          className="mt-6 max-w-[68ch] text-base leading-7 text-text-primary [&_h1]:mt-8 [&_h1]:mb-3 [&_h1]:text-2xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_p]:my-4 [&_ul]:my-4 [&_ol]:my-4 [&_li]:my-1 [&_pre]:my-4 [&_code]:text-sm [&_pre_code]:text-sm [&_table]:text-sm [&_blockquote]:my-4"
        >
          {stripLeadingTitle(doc.body, doc.title)}
        </MarkdownContent>
      </article>

      {others.length > 0 ? (
        <>
          <aside className="hidden lg:order-2 lg:block" aria-label="More docs">
            <div className="sticky top-6 flex flex-col gap-2">
              <h2 className="px-2.5 text-xs font-semibold tracking-wide text-text-subtle uppercase">More docs</h2>
              <DocNavList docs={others} base={docsBase} currentId={doc.id} />
            </div>
          </aside>
          <Collapsible className="rounded-lg border border-border-default bg-surface-panel lg:hidden" data-testid="portal-doc-nav-mobile">
            <CollapsibleTrigger className="w-full cursor-pointer px-3 py-2.5 text-left text-sm font-medium text-text-primary">More docs ({others.length})</CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-border-default p-2">
                <DocNavList docs={others} base={docsBase} currentId={doc.id} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : null}
    </div>
  )
}
