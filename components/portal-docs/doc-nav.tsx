import Link from "next/link"
import { FileText } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PublicDocSummary } from "@/lib/portal-docs/types"

/** Sidebar list of published docs. Server-safe; links only to ids that came from listPublishedDocs. */
export function DocNavList({ docs, base, currentId }: { docs: PublicDocSummary[]; base: string; currentId: string }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {docs.map((doc) => {
        const active = doc.id === currentId
        return (
          <li key={doc.id}>
            <Link
              href={`${base}/${doc.id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-start gap-2 rounded-md px-2.5 py-1.5 text-sm leading-5 transition-colors",
                active ? "bg-surface-interactive font-medium text-text-primary" : "text-text-secondary hover:bg-surface-inset hover:text-text-primary",
              )}
            >
              <FileText className="mt-0.5 size-3.5 shrink-0 text-text-subtle" aria-hidden />
              <span className="min-w-0 break-words">{doc.title || "Untitled"}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export function DocBreadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-text-subtle">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {item.href ? (
              <Link href={item.href} className="hover:text-text-primary hover:underline">{item.label}</Link>
            ) : (
              <span aria-current="page" className="truncate text-text-secondary">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
