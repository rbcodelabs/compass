/**
 * markdown-table-serialization — a table serializer that makes GFM tables
 * survive a save cycle intact.
 *
 * Docs are stored as markdown and rewritten from the editor's document on every
 * save, so the serializer is the storage format. `tiptap-markdown@0.9.0` ships a
 * table serializer, but it loses information in two ways:
 *
 *   1. It writes cell content verbatim, never escaping `|`. A cell containing a
 *      literal pipe (`string | null`) is emitted unescaped, re-parses as an
 *      extra column, and the overflow column is then dropped — silent, partial,
 *      irreversible content loss.
 *   2. It always writes a `---` delimiter row, discarding the column alignment
 *      that was parsed in from `:---` / `---:` / `:---:`.
 *
 * Both are fixed here, at the cell boundary, and nowhere else. Escaping is
 * applied to each cell's *rendered* markdown rather than to the text node,
 * which matters for two reasons:
 *
 *   - prosemirror-markdown special-cases marks whose spec sets `escape: false`
 *     (i.e. `code`): for those it writes the text directly and never calls the
 *     text node's serializer at all. A text-node override therefore cannot see
 *     a pipe inside an inline code span — `` `cat x | grep y` `` would still
 *     break the row.
 *   - Working per-cell means text outside a table is untouched: the shared text
 *     serializer is left exactly as tiptap-markdown defines it, so non-table
 *     documents serialize through identical code.
 */

import { Node as PMNode, Fragment } from "@tiptap/pm/model";
import { getHTMLFromFragment } from "@tiptap/react";
import { Table } from "@tiptap/extension-table";

/**
 * The subset of tiptap-markdown's MarkdownSerializerState we rely on. It
 * extends prosemirror-markdown's state with `inTable`, which it sets while
 * serializing a table (hard breaks render differently inside one).
 */
interface TableAwareSerializerState {
  inTable: boolean;
  out: string;
  /**
   * Pending whitespace-trim bookkeeping. tiptap-markdown records absolute
   * offsets into `out` when a mark that expels enclosing whitespace (bold,
   * italic) opens and closes, then applies the trim after the *next* node
   * renders. Rewriting `out` underneath those offsets corrupts the trim, so
   * anything that edits `out` in place has to keep them in sync.
   */
  inlines: { start?: number; end?: number }[];
  write(content?: string): void;
  ensureNewLine(): void;
  closeBlock(node: PMNode): void;
  renderInline(node: PMNode): void;
}

type CellAlignment = "left" | "center" | "right" | null;

const ALIGNMENT_DELIMITERS: Record<Exclude<CellAlignment, null>, string> = {
  left: ":---",
  center: ":---:",
  right: "---:",
};

function childNodes(node: PMNode | undefined): PMNode[] {
  return (node?.content as unknown as { content?: PMNode[] })?.content ?? [];
}

function hasSpan(node: PMNode): boolean {
  return node.attrs.colspan > 1 || node.attrs.rowspan > 1;
}

/**
 * Whether the table can be expressed as a GFM pipe table at all. Mirrors
 * tiptap-markdown's own check: a single header row, no merged cells, one block
 * per cell. Merged cells can only reach a doc through an HTML paste.
 */
function isMarkdownSerializable(node: PMNode): boolean {
  const rows = childNodes(node);
  const [firstRow, ...bodyRows] = rows;
  if (
    childNodes(firstRow).some(
      (cell) => cell.type.name !== "tableHeader" || hasSpan(cell) || cell.childCount > 1
    )
  ) {
    return false;
  }
  return !bodyRows.some((row) =>
    childNodes(row).some(
      (cell) => cell.type.name === "tableHeader" || hasSpan(cell) || cell.childCount > 1
    )
  );
}

function normalizeAlignment(value: unknown): CellAlignment {
  return value === "left" || value === "center" || value === "right" ? value : null;
}

/**
 * Per-column alignment, taken from the first cell in each column that declares
 * one. Alignment is a property of the column in markdown, but the parser copies
 * it onto every cell, so any row is a valid source.
 */
function columnAlignments(node: PMNode): CellAlignment[] {
  const rows = childNodes(node);
  const columnCount = rows.reduce((max, row) => Math.max(max, childNodes(row).length), 0);
  const alignments: CellAlignment[] = Array.from({ length: columnCount }, () => null);
  for (const row of rows) {
    childNodes(row).forEach((cell, index) => {
      if (!alignments[index]) alignments[index] = normalizeAlignment(cell.attrs.align);
    });
  }
  return alignments;
}

/**
 * Render one cell, then escape every `|` it produced.
 *
 * A row is split on unescaped pipes before its cells are inline-parsed, so any
 * pipe surviving into the output — plain text, inside emphasis, or inside a
 * code span — would create a phantom column. Nothing else in the pipeline emits
 * `\|`, so every pipe in the rendered slice is unescaped and needs escaping;
 * that also makes this idempotent across repeated saves, because reparsing
 * turns `\|` back into a plain `|` in the cell's text.
 */
function renderCellEscapingPipes(state: TableAwareSerializerState, cell: PMNode): void {
  const start = state.out.length;
  state.renderInline(cell);
  const rendered = state.out.slice(start);
  if (!rendered.includes("|")) return;

  state.out = state.out.slice(0, start) + rendered.replace(/\|/g, "\\|");

  // Every escape inserts one character, so an offset pointing into this cell
  // moves right by the number of pipes escaped before it. Without this, a
  // pending trim (see `inlines` above) would cut at the wrong index and mangle
  // the emphasis delimiters — e.g. `**a \| b**` coming back as `**a \|** *`.
  const shift = (offset: number): number => {
    if (offset <= start) return offset;
    const limit = Math.min(offset - start, rendered.length);
    let escapedBefore = 0;
    for (let index = 0; index < limit; index += 1) {
      if (rendered[index] === "|") escapedBefore += 1;
    }
    return offset + escapedBefore;
  };

  for (const inline of state.inlines) {
    if (typeof inline.start === "number") inline.start = shift(inline.start);
    if (typeof inline.end === "number") inline.end = shift(inline.end);
  }
}

/**
 * Table serializer that escapes pipes and preserves column alignment.
 *
 * Otherwise identical in shape to tiptap-markdown's: same cell iteration, same
 * `| a | b |` spacing, same fallback when the table cannot be represented as
 * GFM.
 */
export const MarkdownAlignedTable = Table.extend({
  addStorage() {
    return {
      markdown: {
        serialize(
          this: { editor: { storage: { markdown: { options: { html: boolean } } } } },
          state: TableAwareSerializerState,
          node: PMNode
        ) {
          if (!isMarkdownSerializable(node)) {
            // Parity with tiptap-markdown's HTMLNode fallback, which is what
            // handled this case before the override. The editor pins
            // `html: false` (see doc-editor-extensions), so in practice this is
            // always the warn-and-placeholder branch; the html branch omits
            // upstream's cosmetic block reflow, which only affects whitespace.
            if (this.editor.storage.markdown.options.html) {
              state.write(getHTMLFromFragment(Fragment.from(node), node.type.schema));
            } else {
              console.warn(
                `Tiptap Markdown: "${node.type.name}" node is only available in html mode`
              );
              state.write(`[${node.type.name}]`);
            }
            if (node.isBlock) state.closeBlock(node);
            return;
          }

          const alignments = columnAlignments(node);
          state.inTable = true;
          node.forEach((row, _offset, rowIndex) => {
            state.write("| ");
            row.forEach((cell, _cellOffset, cellIndex) => {
              if (cellIndex) state.write(" | ");
              const cellContent = cell.firstChild;
              if (cellContent && cellContent.textContent.trim()) {
                renderCellEscapingPipes(state, cellContent);
              }
            });
            state.write(" |");
            state.ensureNewLine();
            if (!rowIndex) {
              const delimiterRow = Array.from({ length: row.childCount })
                .map((_unused, columnIndex) => {
                  const alignment = alignments[columnIndex];
                  return alignment ? ALIGNMENT_DELIMITERS[alignment] : "---";
                })
                .join(" | ");
              state.write(`| ${delimiterRow} |`);
              state.ensureNewLine();
            }
          });
          state.closeBlock(node);
          state.inTable = false;
        },
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});
