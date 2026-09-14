// @vitest-environment jsdom
/**
 * Docs are stored as markdown strings, and the editor rewrites that string from
 * its own document on every save. So any block the editor can PARSE must also
 * SERIALIZE back — a node that round-trips one way silently destroys content.
 *
 * Before TableKit was added to the extension set there was no table node in the
 * schema, so tiptap-markdown parsed pipe-table syntax and had nowhere to put
 * it: every table collapsed into a single paragraph of run-on text (with the
 * inline bold marks from the cells still applied). These tests pin both halves
 * of the fix — that tables parse into real table nodes, and that saving one
 * gives back equivalent markdown.
 */
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import type { MarkdownStorage } from "tiptap-markdown";
import { createDocEditorExtensions } from "@/components/docs/doc-editor-extensions";

/** A real Compass doc table: 8 columns, right-aligned delimiters, bold cells. */
const TABLE_MD = `| Resource | List | Get by ID | Create | Safe typed update | Canonical URL in object responses | Structured data | Observed gap |
|---|---:|---:|---:|---:|---:|---:|---|
| Opportunities | Yes | Yes | Yes | Partial | No | Yes | Lifecycle update exists; metadata correction does not |
| Roadmap Items | Yes | **No** | Yes | Yes | No | Yes | Listed IDs cannot be fetched individually |
| Feedback | Yes | Yes | Yes | Yes | **Yes** | Yes | Closest current example of the desired contract |
`;

function withEditor<T>(content: string, fn: (editor: Editor) => T): T {
  const editor = new Editor({ extensions: createDocEditorExtensions([]), content });
  try {
    return fn(editor);
  } finally {
    editor.destroy();
  }
}

const toMarkdown = (content: string) =>
  withEditor(content, (editor) =>
    (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown()
  );

/** Rows of cell text, so structure can be asserted without pinning formatting. */
function tableCells(content: string): string[][] {
  return withEditor(content, (editor) => {
    const rows: string[][] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name !== "tableRow") return true;
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
      return false;
    });
    return rows;
  });
}

describe("docs markdown tables", () => {
  it("parses a pipe table into table nodes rather than one flat paragraph", () => {
    const types = withEditor(TABLE_MD, (editor) =>
      editor.state.doc.children.map((node) => node.type.name)
    );
    expect(types).toEqual(["table"]);
  });

  it("preserves every row and cell through parse", () => {
    expect(tableCells(TABLE_MD)).toEqual([
      [
        "Resource",
        "List",
        "Get by ID",
        "Create",
        "Safe typed update",
        "Canonical URL in object responses",
        "Structured data",
        "Observed gap",
      ],
      [
        "Opportunities",
        "Yes",
        "Yes",
        "Yes",
        "Partial",
        "No",
        "Yes",
        "Lifecycle update exists; metadata correction does not",
      ],
      ["Roadmap Items", "Yes", "No", "Yes", "Yes", "No", "Yes", "Listed IDs cannot be fetched individually"],
      ["Feedback", "Yes", "Yes", "Yes", "Yes", "Yes", "Yes", "Closest current example of the desired contract"],
    ]);
  });

  it("serializes the table back out as pipe-table markdown, marks intact", () => {
    const out = toMarkdown(TABLE_MD);
    expect(out).toContain("| Resource | List | Get by ID |");
    expect(out).toContain("| Roadmap Items | Yes | **No** |");
    expect(out).toContain("| Feedback | Yes | Yes | Yes | Yes | **Yes** |");
    // Saving must not lose rows or columns.
    expect(tableCells(out)).toEqual(tableCells(TABLE_MD));
  });

  it("is stable under repeated save cycles", () => {
    const once = toMarkdown(TABLE_MD);
    expect(toMarkdown(once)).toBe(once);
  });

  it("keeps tables intact when mixed with other block content", () => {
    const mixed = [
      "# Heading",
      "",
      "Intro with **bold**.",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "- one",
      "- two",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "Closing [link](https://example.com).",
      "",
    ].join("\n");
    expect(toMarkdown(mixed)).toBe(mixed.trimEnd());
  });

  it("leaves table-free docs byte-identical", () => {
    const plain = "# Title\n\nParagraph with **bold** and *italic*.\n\n1. one\n2. two";
    expect(toMarkdown(plain)).toBe(plain);
  });

  // A table that ends the document serializes with a trailing newline, so these
  // fixtures carry one — the point is that nothing inside the table shifts.
  it("round-trips empty cells without shifting columns", () => {
    const md = "| A | B | C |\n| --- | --- | --- |\n| 1 |  | 3 |\n|  |  |  |\n";
    expect(toMarkdown(md)).toBe(md);
  });

  it("round-trips inline code and links inside cells", () => {
    const md = "| A | B |\n| --- | --- |\n| `code` | [x](https://e.com) |\n";
    expect(toMarkdown(md)).toBe(md);
  });

  // ── Pipes in cells ────────────────────────────────────────────────────────
  // A row is split on unescaped pipes before its cells are inline-parsed, so an
  // unescaped `|` in cell content invents a column and the overflow cell is then
  // dropped. tiptap-markdown 0.9.0 does not escape them; MarkdownAlignedTable
  // does. Without that, the first assertion below yields "| a | b | c |".

  it("escapes a literal pipe in a cell so the column count is preserved", () => {
    const md = "| A | B |\n| --- | --- |\n| a \\| b | c |\n";
    expect(toMarkdown(md)).toBe(md);
    expect(tableCells(md)).toEqual([
      ["A", "B"],
      ["a | b", "c"],
    ]);
  });

  it("keeps pipe-bearing cells stable across repeated saves", () => {
    // The original defect only destroyed content on the *second* save: the
    // phantom column appeared first, then was discarded.
    const md = "| Field | Type | Notes |\n| --- | --- | --- |\n| owner | string \\| null | nullable owner id |\n";
    let current = md;
    for (let pass = 0; pass < 4; pass += 1) {
      current = toMarkdown(current);
      expect(current).toBe(md);
    }
    // The note in the third column is what used to disappear.
    expect(tableCells(md)[1]).toEqual(["owner", "string | null", "nullable owner id"]);
  });

  it("escapes pipes inside inline code and emphasis, not just plain text", () => {
    // prosemirror-markdown writes text carrying a `code` mark directly, without
    // consulting the text node serializer, so escaping has to happen at the
    // cell boundary to reach these.
    const md =
      "| Kind | Value |\n| --- | --- |\n| code | `cat x \\| grep y` |\n| bold | **a \\| b** |\n";
    expect(toMarkdown(md)).toBe(md);
    expect(tableCells(md)).toEqual([
      ["Kind", "Value"],
      ["code", "cat x | grep y"],
      ["bold", "a | b"],
    ]);
  });

  it("leaves pipes outside tables completely alone", () => {
    const md = [
      "A paragraph with string | null in prose.",
      "",
      "Inline code with a pipe: `cat a.txt | grep b`.",
      "",
      "Emphasis around a pipe: **bold | pipe**.",
    ].join("\n");
    expect(toMarkdown(md)).toBe(md);
  });

  // ── Column alignment ──────────────────────────────────────────────────────

  it("preserves every column alignment through a save", () => {
    const md =
      "| Default | Left | Center | Right |\n| --- | :--- | :---: | ---: |\n| a | b | c | d |\n";
    expect(toMarkdown(md)).toBe(md);
  });

  it("preserves the right-aligned columns of the real conformance table", () => {
    // Regression guard for the production doc that prompted this work: seven of
    // its eight columns are `---:`. Before the fix every one came back `---`.
    const out = toMarkdown(TABLE_MD);
    expect(out).toContain("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    expect(toMarkdown(out)).toBe(out);
  });

  it("parses alignment onto the header cells", () => {
    const aligns = withEditor(TABLE_MD, (editor) => {
      const found: (string | null)[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "tableHeader") found.push(node.attrs.align);
        return true;
      });
      return found;
    });
    expect(aligns).toEqual([null, "right", "right", "right", "right", "right", "right", null]);
  });
});
