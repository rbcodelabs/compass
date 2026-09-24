import { Extension } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";

function representableTable(table: Node): boolean {
  let valid = true;
  table.forEach((row, _offset, rowIndex) => row.forEach((cell) => {
    if (
      cell.type.name !== (rowIndex === 0 ? "tableHeader" : "tableCell") ||
      cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1 ||
      cell.childCount !== 1 || cell.firstChild?.type.name !== "paragraph"
    ) valid = false;
    // Markdown table hard breaks serialize as HTML, which descriptions suppress.
    cell.descendants((node) => { if (node.type.name === "hardBreak") valid = false; });
  }));
  return valid;
}

/** Reject edits which a GFM table cannot store, before they can destroy a draft. */
export const DescriptionTableGuard = Extension.create<{ onRejected: () => void }>({
  name: "descriptionTableGuard",
  addOptions() { return { onRejected: () => {} }; },
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction) => {
        if (!transaction.docChanged) return true;
        let valid = true;
        transaction.doc.descendants((node) => {
          if (node.type.name === "table" && !representableTable(node)) valid = false;
        });
        if (!valid) this.options.onRejected();
        return valid;
      },
    })];
  },
});
