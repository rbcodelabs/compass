// @vitest-environment jsdom
import { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { createMarkdownEditorExtensions, editorMarkdown } from "@/components/markdown-editor-extensions";
import { DescriptionTableGuard } from "@/components/description-table-guard";

const mixed = '# Heading\n\n## Second\n\n### Third\n\nA **bold** *italic* ~~deleted~~ [link](https://example.com) and `code`.\n\n- First\n- Second\n\n1. One\n2. Two\n\n> Quoted\n\n```js\nconst value = 1;\n```\n\n---\n\n| Name | Value |\n| :--- | ---: |\n| Example | `string \\| null` |\n';

function create(content = `${mixed}\nFinal paragraph.`, onRejected = vi.fn()) {
  return new Editor({ extensions: [...createMarkdownEditorExtensions(), DescriptionTableGuard.configure({ onRejected })], content });
}

describe("description Markdown round trips", () => {
  it("preserves supported mixed content across five serialize/parse/save cycles", () => {
    const editor = create();
    try {
      const original = editor.getJSON();
      const stable = editorMarkdown(editor);
      for (let cycle = 0; cycle < 5; cycle++) {
        editor.commands.setContent(editorMarkdown(editor));
        expect(editor.getJSON()).toEqual(original);
        expect(editorMarkdown(editor)).toBe(stable);
      }
    } finally { editor.destroy(); }
  });

  it.each([
    ["bold", (editor: Editor) => editor.commands.toggleBold(), "**Word**"],
    ["italic", (editor: Editor) => editor.commands.toggleItalic(), "*Word*"],
    ["strike", (editor: Editor) => editor.commands.toggleStrike(), "~~Word~~"],
    ["code", (editor: Editor) => editor.commands.toggleCode(), "`Word`"],
    ["heading 1", (editor: Editor) => editor.commands.toggleHeading({ level: 1 }), "# Word"],
    ["heading 2", (editor: Editor) => editor.commands.toggleHeading({ level: 2 }), "## Word"],
    ["heading 3", (editor: Editor) => editor.commands.toggleHeading({ level: 3 }), "### Word"],
    ["link", (editor: Editor) => editor.commands.setLink({ href: "https://example.com" }), "[Word](https://example.com)"],
    ["bullet list", (editor: Editor) => editor.commands.toggleBulletList(), "- Word"],
    ["ordered list", (editor: Editor) => editor.commands.toggleOrderedList(), "1. Word"],
    ["blockquote", (editor: Editor) => editor.commands.toggleBlockquote(), "> Word"],
    ["code block", (editor: Editor) => editor.commands.toggleCodeBlock(), "```\nWord\n```"],
  ] as const)("serializes the %s toolbar command", (_name, run, expected) => {
    const editor = create("Word");
    try {
      editor.commands.selectAll();
      run(editor);
      expect(editorMarkdown(editor)).toContain(expected);
      const document = editor.getJSON();
      editor.commands.setContent(editorMarkdown(editor));
      expect(editor.getJSON()).toEqual(document);
    } finally { editor.destroy(); }
  });

  it("supports horizontal rules and undo/redo", () => {
    const editor = create("Word");
    try {
      editor.commands.setTextSelection(5);
      editor.commands.setHorizontalRule();
      expect(editorMarkdown(editor)).toContain("---");
      editor.commands.undo();
      expect(editorMarkdown(editor)).toBe("Word");
      editor.commands.redo();
      expect(editorMarkdown(editor)).toContain("---");
    } finally { editor.destroy(); }
  });

  it("creates and edits a GFM table without losing structure", () => {
    const editor = create("");
    try {
      editor.commands.insertTable({ rows: 3, cols: 2, withHeaderRow: true });
      editor.commands.insertContent("Name");
      editor.commands.addColumnAfter();
      editor.commands.addRowAfter();
      const serialized = editorMarkdown(editor);
      expect(serialized).toContain("Name");
      expect(serialized).not.toContain("[table]");
      const document = editor.getJSON();
      editor.commands.setContent(serialized);
      // Trailing empty paragraphs are an editing affordance, not persisted data.
      expect(editor.getJSON().content?.filter((node) => node.type === "table")).toEqual(document.content?.filter((node) => node.type === "table"));
    } finally { editor.destroy(); }
  });

  it("rejects Enter and complex block formatting inside a cell instead of losing the table", () => {
    const rejected = vi.fn();
    const editor = create("| Header |\n| --- |\n| Body |", rejected);
    try {
      let position = 0;
      editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === "Body") position = pos + 2; });
      editor.commands.setTextSelection(position);
      const before = editorMarkdown(editor);
      editor.commands.splitBlock();
      expect(editorMarkdown(editor)).toBe(before);
      editor.commands.toggleHeading({ level: 2 });
      expect(editorMarkdown(editor)).toBe(before);
      editor.commands.toggleBulletList();
      expect(editorMarkdown(editor)).toBe(before);
      expect(rejected).toHaveBeenCalledTimes(3);
    } finally { editor.destroy(); }
  });
});
