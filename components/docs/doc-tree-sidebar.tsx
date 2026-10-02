"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { FileText, Plus, ChevronRight, Shapes, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { createDoc, createCanvasDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { parseJsonCanvas, MAX_CANVAS_BYTES } from "@/lib/json-canvas";
import { CANVAS_CARD_DRAG_TYPE } from "@/lib/canvas-cards";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export type DocTreeItem = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  children: DocTreeItem[];
  sortOrder: number;
  docType?: string;
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
  const operation = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  function handleNewCanvas(content?: string, title?: string) {
    startTransition(async () => {
      operation.current ??= crypto.randomUUID();
      try {
        const doc = await createCanvasDoc(workspaceId, null, revalidatePathStr, { title, content }, { operationId: operation.current });
        operation.current = null;
        setError(null);
        router.push(`${basePath}/${doc.id}`);
      } catch { setError("Could not create this canvas. Try again."); }
    });
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_CANVAS_BYTES) { setError(`That file is too large to import (limit ${Math.round(MAX_CANVAS_BYTES / 1000)} KB).`); return; }
    const text = await file.text();
    const parsed = parseJsonCanvas(text);
    if (!parsed.ok) { setError(`Not a valid .canvas file: ${parsed.errors.slice(0, 3).join("; ")}`); return; }
    handleNewCanvas(text, file.name.replace(/\.canvas$/i, "") || undefined);
  }

  function handleNewPage() {
    startTransition(async () => {
      operation.current ??= crypto.randomUUID();
      try {
        const doc = await createDoc(workspaceId, null, revalidatePathStr, { operationId: operation.current });
        operation.current = null;
        setError(null);
        router.push(`${basePath}/${doc.id}`);
      } catch { setError("Could not create this page. Click New to retry."); }
    });
  }

  return (
    <div className="flex flex-col h-full">
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
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
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={isPending}
            data-testid="new-canvas-menu"
            className="flex items-center gap-1 text-xs text-text-subtle hover:text-text-primary transition-colors px-1 py-0.5 rounded hover:bg-surface-inset disabled:opacity-50"
          >
            <Shapes className="w-3.5 h-3.5" />
            Canvas
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => handleNewCanvas()}>
              <Shapes className="w-3.5 h-3.5" />
              Blank canvas
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => importInput.current?.click()}>
              <Upload className="w-3.5 h-3.5" />
              Import .canvas file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={importInput}
          type="file"
          accept=".canvas,application/json"
          className="hidden"
          data-testid="import-canvas-input"
          onChange={handleImportFile}
        />
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
  const operation = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const href = `${basePath}/${doc.id}`;
  const isActive = pathname === href;
  const hasChildren = doc.children.length > 0;

  function handleAddChild() {
    startTransition(async () => {
      operation.current ??= crypto.randomUUID();
      try {
        const newDoc = await createDoc(workspaceId, doc.id, basePath, { operationId: operation.current });
        operation.current = null;
        setError(null);
        router.push(`${basePath}/${newDoc.id}`);
      } catch { setError("Could not create child page. Try again."); }
    });
  }

  return (
    <li>
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md py-1 px-2 text-sm transition-colors",
          isActive
            ? "bg-primary/10 text-primary font-medium"
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
        <Link
          href={href}
          className="flex items-center gap-1.5 flex-1 min-w-0"
          // Drag a page onto an open canvas to add it as a live Compass card.
          onDragStart={(event) => {
            event.dataTransfer.setData(CANVAS_CARD_DRAG_TYPE, JSON.stringify({ kind: "doc", id: doc.id, title: doc.title }));
            event.dataTransfer.effectAllowed = "copyLink";
          }}
        >
          {doc.icon ? (
            <span className="shrink-0 text-sm leading-none">{doc.icon}</span>
          ) : doc.docType === "CANVAS" ? (
            <Shapes
              className={cn(
                "w-3.5 h-3.5 shrink-0",
                isActive ? "text-primary" : "text-text-subtle"
              )}
            />
          ) : (
            <FileText
              className={cn(
                "w-3.5 h-3.5 shrink-0",
                isActive ? "text-primary" : "text-text-subtle"
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
            "shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-surface-interactive-hover transition-opacity",
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
