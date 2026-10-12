"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Box, ExternalLink, FileText, Plus, ChevronRight, Shapes, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { createDoc, createCanvasDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";
import { parseJsonCanvas, MAX_CANVAS_BYTES } from "@/lib/json-canvas";
import { CANVAS_CARD_DRAG_TYPE } from "@/lib/canvas-cards";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ArtifactNavItem } from "./artifact-nav";

type LibraryFilter = "All" | "Docs" | "Diagrams" | "Artifacts";
const filters: LibraryFilter[] = ["All", "Docs", "Diagrams", "Artifacts"];

function filterDocs(items: DocTreeItem[], filter: LibraryFilter, query: string): DocTreeItem[] {
  return items.flatMap((doc) => {
    const children = filterDocs(doc.children, filter, query);
    const matchesType = filter === "All" || (doc.docType === "CANVAS" ? filter === "Diagrams" : filter === "Docs");
    const matches = matchesType && (doc.title || "Untitled").toLocaleLowerCase().includes(query);
    return matches || children.length ? [{ ...doc, children, contextOnly: !matches }] : [];
  });
}

export type DocTreeItem = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  children: DocTreeItem[];
  sortOrder: number;
  docType?: string;
  contextOnly?: boolean;
};

interface DocTreeSidebarProps {
  docs: DocTreeItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  artifacts: ArtifactNavItem[];
}

export function DocTreeSidebar({
  docs,
  orgSlug,
  workspaceSlug,
  workspaceId,
  artifacts,
}: DocTreeSidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const basePath = `/${orgSlug}/${workspaceSlug}/docs`;
  const revalidatePathStr = basePath;

  const [isPending, startTransition] = useTransition();
  const operation = useRef<{ key: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<LibraryFilter>("All");
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const filteredDocs = filterDocs(docs, filter, query);
  const filteredArtifacts = (filter === "All" || filter === "Artifacts")
    ? artifacts.filter((artifact) => artifact.title.toLocaleLowerCase().includes(query)) : [];
  const entries = [
    ...filteredDocs.map((doc) => ({ kind: "doc" as const, id: doc.id, title: doc.title || "Untitled", doc })),
    ...filteredArtifacts.map((artifact) => ({ kind: "artifact" as const, id: artifact.id, title: artifact.title, artifact })),
  ].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  function handleNewCanvas(content?: string, title?: string) {
    startTransition(async () => {
      const key = JSON.stringify(["canvas", content, title]);
      if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
      try {
        const doc = await createCanvasDoc(workspaceId, null, revalidatePathStr, { title, content }, { operationId: operation.current.id });
        operation.current = null;
        setError(null);
        setFilter("All");
        setSearch("");
        router.push(`${basePath}/${doc.id}`);
      } catch { setError("Could not create this canvas. Try again."); }
    });
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_CANVAS_BYTES) { setError(`That file is too large to import (limit ${Math.round(MAX_CANVAS_BYTES / 1000)} KB).`); return; }
    let text: string;
    try { text = await file.text(); }
    catch { setError("Could not read this file. Try again."); return; }
    const parsed = parseJsonCanvas(text);
    if (!parsed.ok) { setError(`Not a valid .canvas file: ${parsed.errors.slice(0, 3).join("; ")}`); return; }
    handleNewCanvas(text, file.name.replace(/\.canvas$/i, "") || undefined);
  }

  function handleNewPage() {
    startTransition(async () => {
      if (operation.current?.key !== "doc") operation.current = { key: "doc", id: crypto.randomUUID() };
      try {
        const doc = await createDoc(workspaceId, null, revalidatePathStr, { operationId: operation.current.id });
        operation.current = null;
        setError(null);
        setFilter("All");
        setSearch("");
        router.push(`${basePath}/${doc.id}`);
      } catch { setError("Could not create this page. Click New to retry."); }
    });
  }

  return (
    <nav aria-label="Library" className="flex min-h-0 flex-1 flex-col">
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
      <div className="flex shrink-0 items-center justify-between px-2 pb-2 pt-1">
        <span className="truncate text-sm font-semibold text-text-primary">
          Library
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" />}
            disabled={isPending}
            data-testid="library-create-menu"
            className="flex items-center gap-1 text-xs text-text-subtle hover:text-text-primary transition-colors px-1 py-0.5 rounded hover:bg-surface-inset disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" />
            New
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={handleNewPage}>
              <FileText className="w-3.5 h-3.5" /> New doc
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleNewCanvas()}>
              <Shapes className="w-3.5 h-3.5" />
              New diagram
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push(`${basePath}/artifacts/new`)}>
              <Box className="w-3.5 h-3.5" /> New artifact
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => importInput.current?.click()}>
              <Upload className="w-3.5 h-3.5" />
              Import .canvas file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        <input
          ref={importInput}
          type="file"
          accept=".canvas,application/json"
          className="hidden"
          data-testid="import-canvas-input"
          onChange={handleImportFile}
        />
      </div>

      <div className="shrink-0 space-y-2 px-1 pb-3">
        <Input aria-label="Find in library" placeholder="Find in library…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="flex gap-0.5" role="group" aria-label="Library item types">
          {filters.map((type) => <Button key={type} variant={filter === type ? "secondary" : "ghost"} size="xs" className="px-1.5 text-[11px]" aria-pressed={filter === type} onClick={() => setFilter(type)}>{type}</Button>)}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0" data-testid="library-scroll">
        {entries.length === 0 ? (
          <p className="text-xs text-text-subtle px-2 py-1">{docs.length || artifacts.length ? "No matching items." : "No items yet. Use New to add a doc, diagram, or artifact."}</p>
        ) : (
          <ul>{entries.map((entry) => entry.kind === "doc" ? (
            <DocTreeNode key={`doc-${entry.id}`} doc={entry.doc} orgSlug={orgSlug} workspaceSlug={workspaceSlug} workspaceId={workspaceId} pathname={pathname} basePath={basePath} depth={0} forceExpanded={filter !== "All" || !!query} />
          ) : (
            <li key={`artifact-${entry.id}`}>
              <Link href={`${basePath}/artifacts/${entry.id}`} aria-current={pathname === `${basePath}/artifacts/${entry.id}` ? "page" : undefined} className={cn("flex items-center gap-1.5 rounded-md py-1 px-2 pl-7 text-sm", pathname === `${basePath}/artifacts/${entry.id}` ? "bg-primary/10 text-primary font-medium" : "text-text-secondary hover:bg-surface-inset")}>
                {entry.artifact.sourceType === "EXTERNAL_LINK" ? <ExternalLink aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-text-subtle" /> : <Box aria-hidden="true" className="w-3.5 h-3.5 shrink-0 text-text-subtle" />}
                <span className="truncate">{entry.title}</span>
              </Link>
            </li>
          ))}</ul>
        )}
      </div>
    </nav>
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
  forceExpanded = false,
}: {
  items: DocTreeItem[];
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  pathname: string;
  basePath: string;
  depth: number;
  forceExpanded?: boolean;
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
          forceExpanded={forceExpanded}
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
  forceExpanded = false,
}: {
  doc: DocTreeItem;
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  pathname: string;
  basePath: string;
  depth: number;
  forceExpanded?: boolean;
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
  const expanded = isExpanded || forceExpanded;

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
            : doc.contextOnly ? "text-text-subtle" : "text-text-secondary hover:bg-surface-inset"
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
          tabIndex={hasChildren ? 0 : -1}
          disabled={!hasChildren || forceExpanded}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${doc.title || "Untitled"}`}
        >
          <ChevronRight
            className={cn(
              "w-3 h-3 text-text-subtle transition-transform",
              expanded && "rotate-90"
            )}
          />
        </button>

        {/* Icon + title link */}
        <Link
          href={href}
          aria-current={isActive ? "page" : undefined}
          title={doc.contextOnly ? "Parent context" : undefined}
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
            isHovered ? "opacity-100" : "opacity-0 focus-visible:opacity-100"
          )}
          title="Add child page"
          aria-label={`Add child page to ${doc.title || "Untitled"}`}
        >
          <Plus className="w-3 h-3 text-text-subtle" />
        </button>
      </div>

      {/* Children */}
      {hasChildren && (isExpanded || forceExpanded) && (
        <DocTreeList
          items={doc.children}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          workspaceId={workspaceId}
          pathname={pathname}
          basePath={basePath}
          depth={depth + 1}
          forceExpanded={forceExpanded}
        />
      )}
    </li>
  );
}
