"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { FileText, Plus, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { createDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

export type DocTreeItem = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  children: DocTreeItem[];
  sortOrder: number;
};

interface DocTreeSidebarProps {
  docs: DocTreeItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
}

export function DocTreeSidebar({
  docs,
  orgSlug,
  workspaceSlug,
  workspaceId,
}: DocTreeSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`;
  const revalidatePathStr = basePath;

  const [isPending, startTransition] = useTransition();

  function handleNewPage() {
    startTransition(async () => {
      const doc = await createDoc(workspaceId, null, revalidatePathStr);
      router.push(`${basePath}/${doc.id}`);
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-xs font-semibold text-text-subtle uppercase tracking-wider">
          Pages
        </span>
        <button
          onClick={handleNewPage}
          disabled={isPending}
          className="flex items-center gap-1 text-xs text-text-subtle hover:text-text-primary transition-colors px-1 py-0.5 rounded hover:bg-surface-inset disabled:opacity-50"
          title="New page"
        >
          <Plus className="w-3.5 h-3.5" />
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {docs.length === 0 ? (
          <p className="text-xs text-text-subtle px-2 py-1">No pages yet.</p>
        ) : (
          <DocTreeList
            items={docs}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            pathname={pathname}
            basePath={basePath}
            depth={0}
          />
        )}
      </div>
    </div>
  );
}

function DocTreeList({
  items,
  orgSlug,
  workspaceSlug,
  workspaceId,
  pathname,
  basePath,
  depth,
}: {
  items: DocTreeItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  pathname: string;
  basePath: string;
  depth: number;
}) {
  return (
    <ul className="space-y-0">
      {items.map((doc) => (
        <DocTreeNode
          key={doc.id}
          doc={doc}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          pathname={pathname}
          basePath={basePath}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function DocTreeNode({
  doc,
  orgSlug,
  workspaceSlug,
  workspaceId,
  pathname,
  basePath,
  depth,
}: {
  doc: DocTreeItem;
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  pathname: string;
  basePath: string;
  depth: number;
}) {
  const router = useRouter();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [isHovered, setIsHovered] = useState(false);

  const href = `${basePath}/${doc.id}`;
  const isActive = pathname === href;
  const hasChildren = doc.children.length > 0;

  function handleAddChild() {
    startTransition(async () => {
      const newDoc = await createDoc(workspaceId, doc.id, basePath);
      router.push(`${basePath}/${newDoc.id}`);
    });
  }

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md py-1 px-2 text-sm transition-colors",
          isActive
            ? "bg-indigo-50 text-indigo-700 font-medium"
            : "text-text-secondary hover:bg-surface-inset"
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Expand/collapse toggle */}
        <button
          onClick={() => setIsExpanded((v) => !v)}
          className={cn(
            "shrink-0 w-4 h-4 flex items-center justify-center rounded transition-transform",
            !hasChildren && "invisible"
          )}
          tabIndex={-1}
          aria-label={isExpanded ? "Collapse" : "Expand"}
        >
          <ChevronRight
            className={cn(
              "w-3 h-3 text-text-subtle transition-transform",
              isExpanded && "rotate-90"
            )}
          />
        </button>

        {/* Icon + title link */}
        <Link href={href} className="flex items-center gap-1.5 flex-1 min-w-0">
          {doc.icon ? (
            <span className="shrink-0 text-sm leading-none">{doc.icon}</span>
          ) : (
            <FileText
              className={cn(
                "w-3.5 h-3.5 shrink-0",
                isActive ? "text-indigo-500" : "text-text-subtle"
              )}
            />
          )}
          <span className="truncate">{doc.title || "Untitled"}</span>
        </Link>

        {/* Add child button — visible on hover */}
        <button
          onClick={handleAddChild}
          disabled={isPending}
          className={cn(
            "shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 transition-opacity",
            isHovered ? "opacity-100" : "opacity-0"
          )}
          title="Add child page"
        >
          <Plus className="w-3 h-3 text-text-subtle" />
        </button>
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <DocTreeList
          items={doc.children}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          pathname={pathname}
          basePath={basePath}
          depth={depth + 1}
        />
      )}
    </li>
  );
}
