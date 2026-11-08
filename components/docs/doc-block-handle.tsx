"use client";
/**
 * The left-gutter block handle: hover a top-level block and a "+" (insert a block below, via the "/" menu) and a grip (drag to move the
 * block) appear beside its first line.
 *
 * Built on ProseMirror directly rather than a handle extension, so it adds no dependency: the block under the pointer is found with
 * posAtCoords, "+" inserts an empty paragraph holding "/" (which opens the block menu), and the grip starts an ordinary ProseMirror drag
 * of a NodeSelection (view.dragging), so the editor's own drop handling, drop cursor and undo history do the move.
 *
 * Mounted only for a fine pointer on a wide viewport; touch and narrow screens use the compact toolbar and the "/" menu.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { GripVertical, Plus } from "lucide-react";

type Target = { pos: number; top: number; isEmptyParagraph: boolean };

const HANDLE_HEIGHT = 24;

/** The top-level block under a viewport point, or null (between blocks in the page margin still resolves to the nearest block). */
function blockAt(editor: Editor, clientY: number): { pos: number; dom: HTMLElement } | null {
  const view = editor.view;
  const content = view.dom.getBoundingClientRect();
  // Probe inside the text column so a pointer in the left gutter resolves to the same block as one over the text.
  const hit = view.posAtCoords({ left: content.left + Math.min(24, content.width / 2), top: clientY });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  if ($pos.depth < 1 && hit.inside < 0) return null;
  const start = $pos.depth >= 1 ? $pos.before(1) : hit.inside;
  if (start < 0) return null;
  const dom = view.nodeDOM(start);
  return dom instanceof HTMLElement ? { pos: start, dom } : null;
}

/** Start a ProseMirror drag of the block at `pos`: select it as a node and hand the editor the slice, so its own drop handling moves it. */
function beginBlockDrag(editor: Editor, pos: number, dataTransfer: DataTransfer) {
  const { view } = editor;
  const dom = view.nodeDOM(pos);
  const selection = NodeSelection.create(view.state.doc, pos);
  view.dispatch(view.state.tr.setSelection(selection));
  view.dragging = { slice: selection.content(), move: true };
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData("text/plain", " ");
  if (dom instanceof HTMLElement) dataTransfer.setDragImage(dom, 0, 0);
}

function endBlockDrag(editor: Editor) {
  editor.view.dragging = null;
}

export function DocBlockHandle({ editor, containerRef }: { editor: Editor; containerRef: React.RefObject<HTMLElement | null> }) {
  const [target, setTarget] = useState<Target | null>(null);
  const overHandle = useRef(false);
  const dragging = useRef(false);
  const targetRef = useRef<Target | null>(null);

  const update = useCallback((next: Target | null) => {
    targetRef.current = next;
    // Unmounting the handle under the pointer never delivers a mouseleave, so clear the flag here or the handle could never reappear.
    if (!next) overHandle.current = false;
    setTarget((previous) => (previous && next && previous.pos === next.pos && previous.top === next.top ? previous : next));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMove = (event: MouseEvent) => {
      if (dragging.current || overHandle.current || !editor.isEditable) return;
      const hit = blockAt(editor, event.clientY);
      if (!hit) { update(null); return; }
      const box = container.getBoundingClientRect();
      const rect = hit.dom.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(hit.dom).lineHeight) || 28;
      const node = editor.state.doc.nodeAt(hit.pos);
      update({
        pos: hit.pos,
        top: rect.top - box.top + Math.max(0, (lineHeight - HANDLE_HEIGHT) / 2),
        isEmptyParagraph: node?.type.name === "paragraph" && node.content.size === 0,
      });
    };
    const onLeave = () => { if (!overHandle.current && !dragging.current) update(null); };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
    };
  }, [editor, containerRef, update]);

  // The document changing under the handle (typing, a drop) invalidates the remembered position.
  useEffect(() => {
    const clear = () => { if (!dragging.current) update(null); };
    editor.on("update", clear);
    return () => { editor.off("update", clear); };
  }, [editor, update]);

  function insertBelow() {
    const current = targetRef.current;
    if (!current) return;
    const node = editor.state.doc.nodeAt(current.pos);
    if (!node) return;
    if (current.isEmptyParagraph) {
      editor.chain().focus().setTextSelection(current.pos + 1).insertContent("/").run();
    } else {
      const after = current.pos + node.nodeSize;
      editor.chain().focus().insertContentAt(after, { type: "paragraph", content: [{ type: "text", text: "/" }] }).run();
    }
    update(null);
  }

  function onDragStart(event: React.DragEvent<HTMLButtonElement>) {
    const current = targetRef.current;
    if (!current) { event.preventDefault(); return; }
    dragging.current = true;
    beginBlockDrag(editor, current.pos, event.dataTransfer);
  }

  function onDragEnd() {
    dragging.current = false;
    overHandle.current = false;
    endBlockDrag(editor);
    update(null);
  }

  if (!target) return null;
  return (
    <div
      data-testid="doc-block-handle"
      contentEditable={false}
      className="absolute z-10 hidden items-center gap-0.5 lg:pointer-fine:flex"
      style={{ top: target.top, left: -52, height: HANDLE_HEIGHT }}
      onMouseEnter={() => { overHandle.current = true; }}
      onMouseLeave={() => { overHandle.current = false; }}
    >
      <button
        type="button"
        title="Add block below"
        aria-label="Add block below"
        // Keep the editor's selection until the click has run.
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertBelow}
        className="flex h-6 w-6 items-center justify-center rounded text-text-subtle transition-colors hover:bg-surface-inset hover:text-text-primary"
      >
        <Plus className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Drag to move"
        aria-label="Drag to move block"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-text-subtle transition-colors hover:bg-surface-inset hover:text-text-primary active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
    </div>
  );
}
