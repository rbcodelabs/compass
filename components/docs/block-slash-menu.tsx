"use client";
/**
 * The "/" block menu: a keyboard-first list for inserting a block at the cursor. It is a view over the plugin in block-slash-extension.ts
 * (which only watches the document); choosing a command is an ordinary editor transaction, so it autosaves like any other edit.
 *
 * Order of events: the "/query" text is removed first, then the block is applied to the now-empty paragraph. "Image" removes the text and
 * hands off to the editor's existing upload picker (the file input in doc-editor.tsx), so the upload path is the one the toolbar used.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import type { LucideIcon } from "lucide-react";
import { Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code2, Table2, ImageIcon, Minus } from "lucide-react";
import { placeMenu, type MenuPlacement } from "@/lib/spec-docs/menu-placement";
import { dismissBlockSlash, getBlockSlashState } from "@/components/docs/block-slash-extension";
import type { SlashController, SlashState } from "@/components/docs/spec-slash-extension";

export type BlockCommandId = "h1" | "h2" | "h3" | "bullets" | "numbers" | "quote" | "code" | "table" | "image" | "divider";

export type BlockCommand = { id: BlockCommandId; label: string; hint: string; keywords: string[]; icon: LucideIcon };

export const BLOCK_COMMANDS: readonly BlockCommand[] = [
  { id: "h1", label: "Heading 1", hint: "Large section title", keywords: ["h1", "title", "heading"], icon: Heading1 },
  { id: "h2", label: "Heading 2", hint: "Section heading", keywords: ["h2", "heading", "subtitle"], icon: Heading2 },
  { id: "h3", label: "Heading 3", hint: "Small label heading", keywords: ["h3", "heading", "label"], icon: Heading3 },
  { id: "bullets", label: "Bulleted list", hint: "A simple list", keywords: ["bullet", "ul", "list", "unordered"], icon: List },
  { id: "numbers", label: "Numbered list", hint: "A list with order", keywords: ["number", "ol", "list", "ordered"], icon: ListOrdered },
  { id: "quote", label: "Quote", hint: "Pull out a passage", keywords: ["quote", "blockquote", "callout"], icon: Quote },
  { id: "code", label: "Code block", hint: "Monospaced code", keywords: ["code", "pre", "snippet", "mermaid"], icon: Code2 },
  { id: "table", label: "Table", hint: "Rows and columns", keywords: ["table", "grid"], icon: Table2 },
  { id: "image", label: "Image", hint: "Upload from your device", keywords: ["image", "photo", "picture", "upload"], icon: ImageIcon },
  { id: "divider", label: "Divider", hint: "A break between sections", keywords: ["divider", "hr", "rule", "line", "separator"], icon: Minus },
];

/** Commands whose label or a keyword starts with the typed query (case-insensitive). An empty query offers everything. */
export function filterBlockCommands(query: string): BlockCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...BLOCK_COMMANDS];
  return BLOCK_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().startsWith(q) ||
      command.label.toLowerCase().split(" ").some((word) => word.startsWith(q)) ||
      command.keywords.some((keyword) => keyword.startsWith(q)),
  );
}

/**
 * Remove the "/query" text from the paragraph at `slash.from` and turn it into the chosen block. Returns false if the editor cannot run
 * the command (for instance the table extension is absent), in which case only the typed text has been removed.
 */
export function runBlockCommand(editor: Editor, slash: Pick<SlashState, "from" | "to">, id: BlockCommandId, onPickImage: () => void): boolean {
  const chain = editor.chain().focus().deleteRange({ from: slash.from + 1, to: slash.to - 1 });
  switch (id) {
    case "h1": return chain.setNode("heading", { level: 1 }).run();
    case "h2": return chain.setNode("heading", { level: 2 }).run();
    case "h3": return chain.setNode("heading", { level: 3 }).run();
    case "bullets": return chain.toggleBulletList().run();
    case "numbers": return chain.toggleOrderedList().run();
    case "quote": return chain.toggleBlockquote().run();
    case "code": return chain.toggleCodeBlock().run();
    case "table": return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case "divider": return chain.setHorizontalRule().run();
    case "image": {
      const done = chain.run();
      onPickImage();
      return done;
    }
  }
}

export function BlockSlashMenu({
  editor,
  controller,
  onPickImage,
  enabled = true,
}: {
  editor: Editor | null;
  controller: SlashController;
  onPickImage: () => void;
  enabled?: boolean;
}) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [box, setBox] = useState<MenuPlacement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<SlashState | null>(null);

  useEffect(() => {
    controller.setEnabled(Boolean(editor) && enabled);
    return () => controller.setEnabled(false);
  }, [controller, editor, enabled]);

  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const next = getBlockSlashState(editor.state);
      if (!slashRef.current || slashRef.current.query !== next.query || slashRef.current.active !== next.active) setHighlight(0);
      slashRef.current = next;
      setSlash((previous) => (previous && previous.active === next.active && previous.from === next.from && previous.query === next.query ? previous : next));
    };
    editor.on("transaction", read);
    read();
    return () => {
      editor.off("transaction", read);
      controller.setKeyHandler(null);
    };
  }, [editor, controller]);

  const active = Boolean(slash?.active);
  const visible = useMemo(() => filterBlockCommands(slash?.query ?? ""), [slash?.query]);

  const close = useCallback(() => {
    if (!editor) return;
    const tr = editor.state.tr;
    dismissBlockSlash(tr);
    editor.view.dispatch(tr);
  }, [editor]);

  const choose = useCallback(
    (command: BlockCommand) => {
      if (!editor || !slash) return;
      runBlockCommand(editor, slash, command.id, onPickImage);
    },
    [editor, slash, onPickImage],
  );

  useEffect(() => {
    controller.setKeyHandler((event) => {
      if (event.key === "Escape") { close(); return true; }
      if (visible.length === 0) return false;
      if (event.key === "ArrowDown") { setHighlight((index) => (index + 1) % visible.length); return true; }
      if (event.key === "ArrowUp") { setHighlight((index) => (index - 1 + visible.length) % visible.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { choose(visible[Math.min(highlight, visible.length - 1)]); return true; }
      return false;
    });
  }, [controller, close, choose, visible, highlight]);

  // Fixed to the viewport at the cursor so the menu never takes space in (or shifts) the document.
  useLayoutEffect(() => {
    if (!editor || !active || !slash) return;
    const place = () => {
      const pos = Math.min(Math.max(slash.from + 1, 0), editor.state.doc.content.size);
      let coords: { top: number; bottom: number; left: number };
      try { coords = editor.view.coordsAtPos(pos); } catch { coords = { top: 0, bottom: 0, left: 0 }; }
      const vv = window.visualViewport;
      const viewport = {
        width: vv?.width ?? window.innerWidth,
        height: vv?.height ?? window.innerHeight,
        offsetLeft: vv?.offsetLeft ?? 0,
        offsetTop: vv?.offsetTop ?? 0,
      };
      const next = placeMenu({ caret: coords, viewport, menuHeight: menuRef.current?.offsetHeight ?? 0 });
      setBox((previous) => (previous && previous.top === next.top && previous.left === next.left && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [editor, active, slash, visible.length]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, active]);

  if (!editor || !active || visible.length === 0 || typeof document === "undefined") return null;

  const style = box ? { top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight } : { top: 0, left: 0, width: 280, visibility: "hidden" as const };
  return createPortal(
    <div
      ref={menuRef}
      data-testid="block-slash-menu"
      style={{ position: "fixed", ...style }}
      className="z-50 overflow-y-auto rounded-lg border border-border-default bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      // Clicking the menu must not move the editor selection (that would close it before the click lands).
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-text-subtle">Insert a block</div>
      <ul role="listbox" aria-label="Insert a block" className="m-0 list-none p-0">
        {visible.map((command, index) => {
          const Icon = command.icon;
          return (
            <li key={command.id} role="option" aria-selected={index === highlight} data-testid={`block-slash-${command.id}`}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => choose(command)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left sm:min-h-9 ${index === highlight ? "bg-surface-interactive" : ""} hover:bg-surface-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-default bg-surface-card text-text-secondary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-text-primary">{command.label}</span>
                  <span className="truncate text-xs text-text-subtle">{command.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
