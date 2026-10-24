"use client";
/**
 * The "[[" picker: type "[[" then part of a title, choose an existing record, and it is inserted as an inline compass:// link (drawn as a
 * chip by CompassLink). Search is the workspace search endpoint, which authorizes the viewer; only kinds a doc can embed are offered.
 * Nothing is created and no record is written; the single edit is replacing "[[query" with the link text in an ordinary transaction.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { isDocEmbedKind, normalizeEmbedTitle, type DocEmbedKind } from "@/lib/doc-embeds";
import { DOC_EMBED_KIND_LABEL } from "@/lib/spec-docs/labels";
import { placeMenu, type MenuPlacement } from "@/lib/spec-docs/menu-placement";
import type { WorkspaceSearchResponse } from "@/lib/workspace-search";
import { dismissLinkPicker, getLinkPickerState, type LinkPickerController, type LinkPickerState } from "@/components/docs/compass-link-picker-extension";

export type LinkPickerResult = { kind: DocEmbedKind; id: string; label: string };

const EMPTY: LinkPickerResult[] = [];

export function flattenSearch(response: WorkspaceSearchResponse): LinkPickerResult[] {
  const out: LinkPickerResult[] = [];
  for (const group of response.groups) {
    for (const item of group.items) {
      if (!isDocEmbedKind(item.type)) continue; // feedback and help articles cannot be embedded
      out.push({ kind: item.type, id: item.id, label: item.displayId ? `${item.displayId} ${item.title}` : item.title });
    }
  }
  return out;
}

/** Replace "[[query" with the record's title as a compass:// link. Returns false if the range no longer holds the trigger. */
export function insertCompassLink(editor: Editor, range: { from: number; to: number }, result: LinkPickerResult): boolean {
  const { state } = editor;
  if (range.to > state.doc.content.size || state.doc.textBetween(range.from, Math.min(range.from + 2, range.to)) !== "[[") return false;
  const link = state.schema.marks.link;
  if (!link) return false;
  const text = normalizeEmbedTitle(result.label) ?? result.kind;
  const tr = state.tr.replaceWith(range.from, range.to, state.schema.text(text, [link.create({ href: `compass://${result.kind}/${result.id}` })]));
  tr.insert(range.from + text.length, state.schema.text(" "));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function CompassLinkPickerMenu({ editor, controller, orgSlug, workspaceSlug }: { editor: Editor | null; controller: LinkPickerController; orgSlug: string; workspaceSlug: string }) {
  const [picker, setPicker] = useState<LinkPickerState | null>(null);
  const [fetched, setResults] = useState<LinkPickerResult[]>([]);
  const [fetchStatus, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [highlight, setHighlight] = useState(0);
  const [box, setBox] = useState<MenuPlacement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    controller.setEnabled(Boolean(editor));
    return () => controller.setEnabled(false);
  }, [controller, editor]);

  useEffect(() => {
    if (!editor) return;
    const read = () => {
      const next = getLinkPickerState(editor.state);
      setPicker((previous) => (previous && previous.active === next.active && previous.from === next.from && previous.to === next.to && previous.query === next.query ? previous : next));
    };
    editor.on("transaction", read);
    read();
    return () => { editor.off("transaction", read); controller.setKeyHandler(null); };
  }, [editor, controller]);

  const active = Boolean(picker?.active);
  const query = (picker?.query ?? "").trim();
  const searchable = active && query.length >= 2;
  const results = searchable ? fetched : EMPTY;
  const status = searchable ? fetchStatus : "idle";

  useEffect(() => {
    if (!active || query.length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const params = new URLSearchParams({ orgSlug, workspaceSlug, q: query });
        const response = await fetch(`/api/workspace-search?${params}`, { signal: abort.signal });
        if (!response.ok) throw new Error(String(response.status));
        setResults(flattenSearch((await response.json()) as WorkspaceSearchResponse));
        setHighlight(0);
        setStatus("idle");
      } catch {
        if (!abort.signal.aborted) { setResults([]); setStatus("error"); }
      }
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [active, query, orgSlug, workspaceSlug]);

  const close = useCallback(() => {
    if (!editor) return;
    const tr = editor.state.tr;
    dismissLinkPicker(tr);
    editor.view.dispatch(tr);
  }, [editor]);

  const choose = useCallback(
    (result: LinkPickerResult) => {
      if (!editor || !picker) return;
      if (insertCompassLink(editor, picker, result)) editor.view.focus();
      else close();
    },
    [editor, picker, close]
  );

  const selected = useMemo(() => results[Math.min(highlight, Math.max(results.length - 1, 0))], [results, highlight]);
  useEffect(() => {
    controller.setKeyHandler((event) => {
      if (event.key === "Escape") { close(); return true; }
      if (results.length === 0) return false;
      if (event.key === "ArrowDown") { setHighlight((i) => (i + 1) % results.length); return true; }
      if (event.key === "ArrowUp") { setHighlight((i) => (i - 1 + results.length) % results.length); return true; }
      if ((event.key === "Enter" || event.key === "Tab") && selected) { choose(selected); return true; }
      return false;
    });
  }, [controller, close, choose, results, selected]);

  useLayoutEffect(() => {
    if (!editor || !active || !picker) return;
    const place = () => {
      let coords = { top: 0, bottom: 0, left: 0 };
      try { coords = editor.view.coordsAtPos(Math.min(picker.to, editor.state.doc.content.size)); } catch { /* keep the fallback */ }
      const vv = window.visualViewport;
      const viewport = { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight, offsetLeft: vv?.offsetLeft ?? 0, offsetTop: vv?.offsetTop ?? 0 };
      const next = placeMenu({ caret: coords, viewport, menuHeight: menuRef.current?.offsetHeight ?? 0 });
      setBox((p) => (p && p.top === next.top && p.left === next.left && p.width === next.width && p.maxHeight === next.maxHeight ? p : next));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [editor, active, picker, results.length, status]);

  if (!editor || !active || typeof document === "undefined") return null;
  const style = box ? { top: box.top, left: box.left, width: box.width, maxHeight: box.maxHeight } : { top: 0, left: 0, width: 280, visibility: "hidden" as const };
  const hint = query.length < 2 ? "Type to search records" : status === "loading" ? "Searching..." : status === "error" ? "Search failed" : results.length === 0 ? "No matching records" : null;
  return createPortal(
    <div
      ref={menuRef}
      data-testid="compass-link-picker"
      style={{ position: "fixed", ...style }}
      className="z-50 overflow-y-auto rounded-lg border border-border-default bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      onMouseDown={(event) => event.preventDefault()}
    >
      {hint ? <p role="status" className="px-2 py-1.5 text-xs text-text-subtle">{hint}</p> : null}
      {results.length > 0 ? (
        <ul role="listbox" aria-label="Link a record" className="m-0 list-none p-0">
          {results.map((result, index) => (
            <li key={`${result.kind}:${result.id}`} role="option" aria-selected={index === highlight} data-testid="compass-link-option">
              <button
                type="button"
                tabIndex={-1}
                onClick={() => choose(result)}
                onMouseEnter={() => setHighlight(index)}
                className={`flex min-h-11 w-full min-w-0 flex-col items-start justify-center rounded-md px-2 py-1.5 text-left sm:min-h-9 ${index === highlight ? "bg-surface-interactive" : ""} hover:bg-surface-interactive`}
              >
                <span className="w-full truncate text-sm font-medium text-text-primary">{result.label}</span>
                <span className="text-xs text-text-subtle">{DOC_EMBED_KIND_LABEL[result.kind]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>,
    document.body
  );
}
