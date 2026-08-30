"use client"

import Link from "next/link"
import { Box, ExternalLink, Plus } from "lucide-react"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

export type ArtifactNavItem = { id: string; title: string; sourceType: string }

export function ArtifactNav({ artifacts, basePath }: { artifacts: ArtifactNavItem[]; basePath: string }) {
  const pathname = usePathname()
  return (
    <section className="border-t border-border-default pt-3 mt-3" aria-label="Artifacts">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-xs font-semibold text-text-subtle uppercase tracking-wider">Artifacts</span>
        <Link href={`${basePath}/artifacts/new`} className="flex items-center gap-1 text-xs text-text-subtle hover:text-text-primary px-1 py-0.5 rounded hover:bg-surface-interactive">
          <Plus className="w-3.5 h-3.5" /> New
        </Link>
      </div>
      {artifacts.length === 0 ? <p className="text-xs text-text-disabled px-2 py-1">No artifacts yet.</p> : (
        <ul className="space-y-0.5">
          {artifacts.map((artifact) => {
            const href = `${basePath}/artifacts/${artifact.id}`
            return <li key={artifact.id}>
              <Link href={href} className={cn("flex items-center gap-1.5 rounded-md py-1 px-2 text-sm", pathname === href ? "bg-primary/10 text-primary font-medium" : "text-text-secondary hover:bg-surface-interactive")}>
                {artifact.sourceType === "EXTERNAL_LINK" ? <ExternalLink className="w-3.5 h-3.5 text-text-disabled" /> : <Box className="w-3.5 h-3.5 text-text-disabled" />}
                <span className="truncate">{artifact.title}</span>
              </Link>
            </li>
          })}
        </ul>
      )}
    </section>
  )
}
