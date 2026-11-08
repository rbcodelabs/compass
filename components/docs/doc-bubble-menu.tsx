"use client";
/**
 * The selection bubble: appears above selected text (desktop, fine pointer) with the inline formatting a writer reaches for mid-sentence,
 * plus "comment on selection". It replaces the old sticky toolbar on desktop; touch and narrow screens keep a compact toolbar instead.
 *
 * Commenting keeps its contract: the button is titled "Comment on selection" and hands the editor's current selection to the same
 * handler the toolbar button used, so anchors are captured exactly as before. Link editing is inline (an input replaces the buttons), so
 * nothing leaves the bubble.
 */
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import { useEditorState, type Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { Bold, Italic, Link2, Heading2, Heading3, Code, MessageSquarePlus, Check, X, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";

/** Accept "example.com", "https://…", "mailto:…", "compass://…" and relative links; reject anything else (notably javascript:). */
export function normalizeLinkHref(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^(https?:|mailto:|tel:|compass:)/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  if (value.startsWith("/") || value.startsWith("#")) return value;
  return `https://${value}`;
}

export function DocBubbleMenu({
  editor,
  onComment,
  scrollTarget,
  suppressed,
}: {
  editor: Editor;
  onComment: (anchorRect: DOMRect | null) => void;
  /** The scrolling column; the bubble re-places itself as it scrolls. */
  scrollTarget: HTMLElement | null;
  /** True while something else (the comment composer) owns the selection; the bubble stays out of its way. */
  suppressed: boolean;
}) {
  const [linkMode, setLinkMode] = useState(false);
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const commentRef = useRef<HTMLButtonElement>(null);
  // Active states, re-rendered only when one of them actually changes (a re-render on every transaction would make the menu plugin
  // re-register and dispatch another transaction, forever).
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      link: e.isActive("link"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      code: e.isActive("code"),
    }),
  });
  const suppressedRef = useRef(suppressed);
  suppressedRef.current = suppressed;
  const options = useMemo(
    () => ({
      strategy: "fixed" as const,
      placement: "top" as const,
      offset: 8,
      flip: true,
      shift: { padding: 8 },
      ...(scrollTarget ? { scrollTarget } : {}),
      onHide: () => setLinkMode(false),
    }),
    [scrollTarget],
  );
  const shouldShow = useCallback<NonNullable<BubbleMenuProps["shouldShow"]>>(
    ({ state, from, to, view, element }) => {
      if (suppressedRef.current || !editor.isEditable) return false;
      if (state.selection.empty || from === to) return false;
      if (state.selection instanceof NodeSelection) return false;
      if (editor.isActive("codeBlock")) return false;
      if (!state.doc.textBetween(from, to).trim()) return false;
      return view.hasFocus() || element.contains(document.activeElement);
    },
    [editor],
  );
  const appendTo = useCallback(() => document.body, []);

  useEffect(() => { if (linkMode) inputRef.current?.focus(); }, [linkMode]);

  function openLink() {
    setHref((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkMode(true);
  }

  function closeLink(refocus = true) {
    setLinkMode(false);
    if (refocus) editor.chain().focus().run();
  }

  function applyLink() {
    const next = normalizeLinkHref(href);
    if (!next) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: next }).run();
    }
    setLinkMode(false);
  }

  const items: Array<{ key: string; title: string; icon: React.ReactNode; active: boolean; run: () => void }> = [
    { key: "bold", title: "Bold", icon: <Bold className="h-4 w-4" />, active: active.bold, run: () => editor.chain().focus().toggleBold().run() },
    { key: "italic", title: "Italic", icon: <Italic className="h-4 w-4" />, active: active.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { key: "link", title: "Link", icon: <Link2 className="h-4 w-4" />, active: active.link, run: openLink },
    { key: "h2", title: "Heading 2", icon: <Heading2 className="h-4 w-4" />, active: active.h2, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: "h3", title: "Heading 3", icon: <Heading3 className="h-4 w-4" />, active: active.h3, run: () => editor.chain().focus().toggleHeading({ level: 3 }).run() },
    { key: "code", title: "Inline code", icon: <Code className="h-4 w-4" />, active: active.code, run: () => editor.chain().focus().toggleCode().run() },
  ];

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="docBubbleMenu"
      updateDelay={60}
      options={options}
      appendTo={appendTo}
      shouldShow={shouldShow}
    >
      <div
        data-testid="doc-bubble-menu"
        role="toolbar"
        aria-label="Format selection"
        className="flex items-center gap-0.5 rounded-lg border border-border-default bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      >
        {linkMode ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => { event.preventDefault(); applyLink(); }}
          >
            <input
              ref={inputRef}
              value={href}
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeLink(); } }}
              placeholder="Paste or type a link"
              aria-label="Link address"
              className="h-7 w-56 rounded-md border border-border-default bg-surface-card px-2 text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <BubbleButton title="Apply link" onClick={() => {}} type="submit"><Check className="h-4 w-4" /></BubbleButton>
            {active.link && (
              <BubbleButton
                title="Remove link"
                onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); setLinkMode(false); }}
              >
                <Unlink className="h-4 w-4" />
              </BubbleButton>
            )}
            <BubbleButton title="Cancel" onClick={() => closeLink()}><X className="h-4 w-4" /></BubbleButton>
          </form>
        ) : (
          <>
            {items.map((item) => (
              <BubbleButton key={item.key} title={item.title} active={item.active} onClick={item.run}>{item.icon}</BubbleButton>
            ))}
            <div className="mx-1 h-5 w-px shrink-0 bg-border-default" />
            <BubbleButton
              ref={commentRef}
              title="Comment on selection"
              onClick={() => onComment(commentRef.current?.getBoundingClientRect() ?? null)}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </BubbleButton>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}


const BubbleButton = forwardRef<
  HTMLButtonElement,
  { title: string; onClick: () => void; active?: boolean; children: React.ReactNode; type?: "button" | "submit" }
>(function BubbleButton({ title, onClick, active, children, type = "button" }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      title={title}
      aria-label={title}
      aria-pressed={active}
      // Keep the editor selection: a mousedown on a button would otherwise blur the editor before the click runs.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
        active ? "bg-primary/10 text-primary" : "text-text-secondary hover:bg-surface-interactive hover:text-text-primary",
      )}
    >
      {children}
    </button>
  );
});
