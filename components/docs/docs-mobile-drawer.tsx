"use client"

import { useState } from "react"
import { PanelLeft } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { DocTreeSidebar, type DocTreeItem } from "./doc-tree-sidebar"
import { Button } from "@/components/ui/button"
import { ArtifactNav, type ArtifactNavItem } from "./artifact-nav"

interface DocsMobileDrawerProps {
  docs: DocTreeItem[]
  orgSlug: string
  workspaceSlug: string
  workspaceId: string
  artifacts: ArtifactNavItem[]
}

export function DocsMobileDrawer({
  docs,
  orgSlug,
  workspaceSlug,
  workspaceId,
  artifacts,
}: DocsMobileDrawerProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* Trigger button — mobile only */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="md:hidden text-text-secondary hover:text-text-primary"
        aria-label="Open docs navigation"
      >
        <PanelLeft className="w-4 h-4" />
        <span className="font-medium">Docs</span>
      </Button>

      {/* Drawer */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-slate-100 shrink-0">
            <SheetTitle className="text-sm font-semibold text-text-secondary">
              Docs
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-2">
            <DocTreeSidebar
              docs={docs}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
            />
            <ArtifactNav artifacts={artifacts} basePath={`/${orgSlug}/${workspaceSlug}/docs`} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
