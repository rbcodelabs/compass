"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { isAllowedUri } from "@tiptap/extension-link";
import {
  BoldIcon, ItalicIcon, StrikethroughIcon, Undo2Icon, Redo2Icon,
  LinkIcon, ListIcon, ListOrderedIcon, QuoteIcon, CodeIcon,
  SquareCodeIcon, MinusIcon, TableIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createMarkdownEditorExtensions, editorMarkdown } from "@/components/markdown-editor-extensions";
import { descriptionSourceOnlyReason } from "@/lib/description-markdown";
import { DescriptionTableGuard } from "@/components/description-table-guard";
import { cn } from "@/lib/utils";

type EditorActions = {
  onSave: () => void;
  onCancel: () => void;
  dirty: boolean;
  saving: boolean;
  error?: string | null;
};

export type MarkdownDescriptionEditorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  id?: string;
  /** Omit when the containing form owns Save/Cancel and its error handling. */
  actions?: EditorActions;
  /** Empty-state guidance. May change after mount; the editor follows it. */
  placeholder?: string;
  /**
   * Grow to fill a flex parent instead of the default 11–24rem box. For hosts
   * that dedicate a region to the body, like the feedback composer panel.
   */
  fill?: boolean;
  /**
   * Receives files pasted or dropped onto the editor. When set, those files
   * are handed over instead of being inserted inline — the feedback composer
   * turns a pasted screenshot into an attachment.
   */
  onFiles?: (files: File[]) => void;
  /** Replaces the formless footer note; `null` hides it. Ignored with `actions`. */
  footerNote?: ReactNode | null;
  className?: string;
};

/**
 * The current placeholder per editor instance. TipTap copies extension
 * options at creation, so a changed prop cannot reach the Placeholder
 * extension directly; its placeholder function looks the text up here instead.
 */
const livePlaceholders = new WeakMap<Editor, string>();

function filesFrom(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  // Some browsers expose a pasted screenshot only as a DataTransferItem.
  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function MarkdownDescriptionEditor({ value, onChange, disabled = false, label, id, actions, placeholder = "Write a description…", fill = false, onFiles, footerNote, className }: MarkdownDescriptionEditorProps) {
  const generatedId = useId();
  const editorId = id ?? generatedId;
  const reason = useMemo(() => descriptionSourceOnlyReason(value), [value]);
  const [mode, setMode] = useState<"rich" | "markdown">(() => reason ? "markdown" : "rich");
  const [showLink, setShowLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [tableNotice, setTableNotice] = useState(false);
  const lastEmitted = useRef(value);
  // Read through a ref: TipTap captures editorProps once, at creation, but the
  // handler may legitimately change afterwards.
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);
  const sourceMode = mode === "markdown" || Boolean(reason);
  const locked = disabled || Boolean(actions?.saving);

  const editor = useEditor({
    extensions: [...createMarkdownEditorExtensions(({ editor: current }) => livePlaceholders.get(current) ?? placeholder), DescriptionTableGuard.configure({ onRejected: () => setTableNotice(true) })],
    content: reason ? "" : value,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editable: !locked,
    editorProps: {
      attributes: {
        id: editorId,
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        class: (fill ? "min-h-full " : "min-h-44 ") + "p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [overflow-wrap:anywhere] [&_p]:my-2 [&_h1]:my-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-2 [&_h3]:text-base [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_code]:font-mono [&_code]:text-xs [&_a]:text-primary [&_a]:underline [&_hr]:my-4 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2 [&_td]:border [&_td]:border-border [&_td]:p-2 [&_.tableWrapper]:overflow-x-auto",
      },
      handlePaste: (_view, event) => {
        const files = onFilesRef.current ? filesFrom(event.clipboardData) : [];
        if (!files.length) return false;
        event.preventDefault();
        onFilesRef.current?.(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = onFilesRef.current ? filesFrom((event as DragEvent).dataTransfer) : [];
        if (!files.length) return false;
        event.preventDefault();
        onFilesRef.current?.(files);
        return true;
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      setTableNotice(false);
      const markdown = editorMarkdown(updatedEditor);
      lastEmitted.current = markdown;
      onChange(markdown);
    },
  });

  useEffect(() => {
    // Permission changes are not document edits. Emitting here would overwrite
    // a source draft with the hidden rich document when a save starts/finishes.
    editor?.setEditable(!locked, false);
  }, [editor, locked]);

  useEffect(() => {
    // Decorations only recompute on a transaction; nudge one so a changed
    // placeholder shows without waiting for the next keystroke.
    if (!editor || editor.isDestroyed || livePlaceholders.get(editor) === placeholder) return;
    livePlaceholders.set(editor, placeholder);
    editor.view.dispatch(editor.state.tr.setMeta("placeholder", placeholder));
  }, [editor, placeholder]);

  useEffect(() => {
    if (!editor || sourceMode || value === lastEmitted.current) return;
    editor.commands.setContent(value, { emitUpdate: false });
    lastEmitted.current = value;
  }, [editor, sourceMode, value]);

  function changeMode(next: "rich" | "markdown") {
    if (!editor || locked || (next === "rich" && reason)) return;
    setShowLink(false);
    if (next === "rich" && sourceMode) {
      editor.commands.setContent(value, { emitUpdate: false });
      lastEmitted.current = value;
    }
    // onUpdate already serializes rich edits. An untouched document keeps its
    // original source, so inspecting modes alone does not dirty a description.
    setMode(next);
  }

  function applyLink() {
    if (!editor) return;
    const href = linkUrl.trim();
    if (href && !isAllowedUri(href)) {
      setLinkError("Enter a valid, safe link URL.");
      return;
    }
    if (!href) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive("link")) {
      editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    } else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setShowLink(false);
    setLinkError(null);
  }

  const controls = editor ? [
    { label: "Undo", icon: Undo2Icon, run: () => editor.chain().focus().undo().run(), disabled: !editor.can().undo() },
    { label: "Redo", icon: Redo2Icon, run: () => editor.chain().focus().redo().run(), disabled: !editor.can().redo() },
    { label: "Bold", icon: BoldIcon, run: () => editor.chain().focus().toggleBold().run(), active: editor.isActive("bold") },
    { label: "Italic", icon: ItalicIcon, run: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive("italic") },
    { label: "Strikethrough", icon: StrikethroughIcon, run: () => editor.chain().focus().toggleStrike().run(), active: editor.isActive("strike") },
    { label: "Link", icon: LinkIcon, run: () => { setLinkUrl(editor.getAttributes("link").href ?? ""); setLinkError(null); setShowLink(!showLink); }, active: editor.isActive("link") },
    { label: "Bullet list", icon: ListIcon, run: () => editor.chain().focus().toggleBulletList().run(), active: editor.isActive("bulletList") },
    { label: "Numbered list", icon: ListOrderedIcon, run: () => editor.chain().focus().toggleOrderedList().run(), active: editor.isActive("orderedList") },
    { label: "Blockquote", icon: QuoteIcon, run: () => editor.chain().focus().toggleBlockquote().run(), active: editor.isActive("blockquote") },
    { label: "Inline code", icon: CodeIcon, run: () => editor.chain().focus().toggleCode().run(), active: editor.isActive("code") },
    { label: "Code block", icon: SquareCodeIcon, run: () => editor.chain().focus().toggleCodeBlock().run(), active: editor.isActive("codeBlock") },
    { label: "Horizontal rule", icon: MinusIcon, run: () => editor.chain().focus().setHorizontalRule().run() },
    { label: "Insert table", icon: TableIcon, run: () => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(), disabled: editor.isActive("table") },
  ] : [];

  return (
    <div className={cn("min-w-0 overflow-hidden rounded-lg border border-input bg-background", fill && "flex min-h-0 flex-1 flex-col", className)} aria-busy={locked} onKeyDown={(event) => {
      // The workspace uses Cmd/Ctrl+B for its sidebar. Formatting shortcuts
      // inside this editor belong to TipTap, not the surrounding application.
      if (event.metaKey || event.ctrlKey) event.stopPropagation();
      if (event.key === "Escape" && showLink) {
        event.preventDefault();
        event.stopPropagation();
        setShowLink(false);
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!locked) {
          if (actions?.dirty) actions.onSave();
          else if (!actions) event.currentTarget.closest("form")?.requestSubmit();
        }
      }
      if (event.key === "Escape" && actions && !locked && !showLink) {
        event.preventDefault();
        event.stopPropagation();
        actions.onCancel();
      }
    }}>
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <div className="flex gap-1 rounded-md bg-muted p-0.5" role="group" aria-label={`${label} editing mode`}>
          <Button type="button" variant={sourceMode ? "ghost" : "secondary"} size="xs" aria-pressed={!sourceMode} disabled={locked || Boolean(reason)} aria-describedby={reason ? `${editorId}-notice` : undefined} onClick={() => changeMode("rich")}>Rich</Button>
          <Button type="button" variant={sourceMode ? "secondary" : "ghost"} size="xs" aria-pressed={sourceMode} disabled={locked} onClick={() => changeMode("markdown")}>Markdown</Button>
        </div>
        {actions && <span className="text-[10px] text-muted-foreground">⌘/Ctrl + Enter</span>}
      </div>
      {!sourceMode && <div role="toolbar" aria-label={`${label} formatting`} className="flex items-center gap-0.5 overflow-x-auto border-b p-1.5">
        {controls.slice(0, 5).map((control) => <Button key={control.label} type="button" variant={control.active ? "secondary" : "ghost"} size="icon-sm" aria-label={control.label} title={control.label} aria-pressed={control.active} disabled={locked || control.disabled} onClick={control.run}><control.icon /></Button>)}
        {([1, 2, 3] as const).map((level) => <Button key={level} type="button" size="icon-sm" variant={editor?.isActive("heading", { level }) ? "secondary" : "ghost"} aria-label={`Heading ${level}`} title={`Heading ${level}`} aria-pressed={editor?.isActive("heading", { level })} disabled={locked} onClick={() => editor?.chain().focus().toggleHeading({ level }).run()}>H{level}</Button>)}
        {controls.slice(5).map((control) => <Button key={control.label} type="button" variant={control.active ? "secondary" : "ghost"} size="icon-sm" aria-label={control.label} title={control.label} aria-pressed={control.active} disabled={locked || control.disabled} onClick={control.run}><control.icon /></Button>)}
      </div>}
      {!sourceMode && editor?.isActive("table") && <div role="toolbar" aria-label="Table editing" className="flex gap-1 overflow-x-auto border-b p-1.5">
        <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => editor.chain().focus().addRowAfter().run()}>Add row</Button>
        <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => editor.chain().focus().addColumnAfter().run()}>Add column</Button>
        <Button type="button" size="xs" variant="ghost" disabled={locked || editor.isActive("tableHeader")} onClick={() => editor.chain().focus().deleteRow().run()}>Delete row</Button>
        <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => editor.chain().focus().deleteColumn().run()}>Delete column</Button>
        <Button type="button" size="xs" variant="ghost" disabled={locked} onClick={() => editor.chain().focus().deleteTable().run()}>Delete table</Button>
      </div>}
      {showLink && !sourceMode && <div className="space-y-2 border-b p-2">
        <Input aria-label="Link URL" placeholder="https://example.com" value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} disabled={locked} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); applyLink(); } }} />
        <div className="flex gap-1">
          <Button type="button" size="xs" onClick={applyLink} disabled={locked}>Apply link</Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => { editor?.chain().focus().extendMarkRange("link").unsetLink().run(); setShowLink(false); }} disabled={locked}>Remove link</Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setShowLink(false)}>Close</Button>
        </div>
        {linkError && <p role="alert" className="text-xs text-destructive">{linkError}</p>}
      </div>}
      {reason && <p id={`${editorId}-notice`} role="note" className="m-2 rounded-md bg-status-warning/10 p-2 text-xs text-muted-foreground">{reason}</p>}
      {tableNotice && <p role="alert" className="m-2 text-xs text-muted-foreground">Markdown tables support one paragraph per cell. This edit was not applied; your table is unchanged.</p>}
      {sourceMode ? <Textarea id={editorId} aria-label={`${label} Markdown source`} aria-describedby={reason ? `${editorId}-notice` : undefined} value={value} onChange={(event) => onChange(event.target.value)} onPaste={(event) => { const files = onFiles ? filesFrom(event.clipboardData) : []; if (files.length) { event.preventDefault(); onFiles?.(files); } }} disabled={locked} placeholder={fill ? placeholder : undefined} className={cn("rounded-none border-0 p-3 font-mono text-xs [field-sizing:fixed]", fill ? "min-h-44 flex-1 resize-none" : "min-h-44 max-h-96 resize-y")} /> : <EditorContent editor={editor} className={cn("min-w-0 overflow-auto", fill ? "min-h-0 flex-1 [&>.tiptap]:min-h-full" : "max-h-96")} />}
      {actions ? <div className="space-y-2 border-t bg-muted/30 p-2">
        {actions.error && <p role="alert" className="text-xs text-destructive">{actions.error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span role="status" className="text-[10px] text-muted-foreground">{actions.saving ? "Saving…" : actions.dirty ? "Unsaved changes" : "No changes"}</span>
          <div className="flex gap-1.5">
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={actions.onCancel}>Cancel</Button>
            <Button type="button" size="sm" disabled={locked || !actions.dirty} onClick={actions.onSave}>{actions.saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div> : footerNote === null ? null : <p className="border-t bg-muted/30 p-2 text-[10px] text-muted-foreground">{footerNote ?? "Saved with the form’s changes."}</p>}
    </div>
  );
}
