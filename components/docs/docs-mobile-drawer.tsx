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

interface DocsMobileDrawerProps {
  docs: DocTreeItem[]
  orgSlug: string
  workspaceSlug: string
  workspaceId: string
}

export function DocsMobileDrawer({
  docs,
  orgSlug,
  workspaceSlug,
  workspaceId,
}: DocsMobileDrawerProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {/* Trigger button — mobile only */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 px-2 py-1.5 rounded-md hover:bg-slate-100 transition-colors"
        aria-label="Open pages"
      >
        <PanelLeft className="w-4 h-4" />
        <span className="font-medium">Pages</span>
      </button>

      {/* Drawer */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-2 border-b border-slate-100 shrink-0">
            <SheetTitle className="text-sm font-semibold text-slate-700">
              Pages
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-2">
            <DocTreeSidebar
              docs={docs}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
