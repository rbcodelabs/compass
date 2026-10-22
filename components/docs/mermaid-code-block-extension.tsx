"use client";

/**
 * MermaidCodeBlock: the ordinary code block, plus a rendered view for fences
 * whose info string is `mermaid`.
 *
 * Storage is deliberately untouched. The node is still `codeBlock` with a
 * `language` attribute, so tiptap-markdown parses and serializes it through its
 * stock code-block rules and a ```mermaid fence round-trips byte for byte —
 * the diagram is purely a view over the node's text. Only the node view
 * differs: for `mermaid` it offers a Preview/Source toggle (source is the real,
 * editable ProseMirror content; the diagram is derived from it).
 */
import { useState } from "react";
import CodeBlock from "@tiptap/extension-code-block";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { MermaidDiagram } from "@/components/mermaid-diagram";

type Mode = "preview" | "source";

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs ${active ? "bg-surface-inset font-medium text-text-primary" : "text-text-subtle hover:text-text-primary"}`}
    >
      {children}
    </button>
  );
}

function MermaidBlockView({ node, editor }: NodeViewProps) {
  const source = node.textContent;
  const [chosen, setChosen] = useState<Mode | null>(null);
  const editable = editor.isEditable;
  // A fresh, empty block opens in source mode so the author can start typing;
  // read-only editors can only ever preview.
  const mode: Mode = !editable ? "preview" : (chosen ?? (source.trim() ? "preview" : "source"));

  return (
    <NodeViewWrapper className="mermaid-block my-3" data-mermaid-block="">
      {editable && (
        <div contentEditable={false} className="mb-1 flex items-center justify-end gap-1" data-testid="mermaid-toolbar">
          <ModeButton active={mode === "preview"} onClick={() => setChosen("preview")}>
            Preview
          </ModeButton>
          <ModeButton active={mode === "source"} onClick={() => setChosen("source")}>
            Source
          </ModeButton>
        </div>
      )}
      {mode === "preview" && (
        <div contentEditable={false} data-testid="mermaid-preview">
          <MermaidDiagram source={source} />
        </div>
      )}
      {/* Always mounted: ProseMirror owns this node's content, so hiding beats unmounting. */}
      <pre className={mode === "source" ? undefined : "hidden"} data-language="mermaid">
        <NodeViewContent<"code"> as="code" className="language-mermaid" />
      </pre>
    </NodeViewWrapper>
  );
}

function PlainCodeBlockView({ node }: NodeViewProps) {
  const language = node.attrs.language as string | null;
  return (
    <NodeViewWrapper as="pre">
      <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : undefined} />
    </NodeViewWrapper>
  );
}

function CodeBlockView(props: NodeViewProps) {
  return props.node.attrs.language === "mermaid" ? <MermaidBlockView {...props} /> : <PlainCodeBlockView {...props} />;
}

export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
});
