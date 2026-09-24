import { remark } from "remark";
import remarkGfm from "remark-gfm";

const parser = remark().use(remarkGfm);

/** AST inspection avoids treating escaped syntax and fenced examples as images/HTML. */
export function descriptionSourceOnlyReason(markdown: string): string | null {
  const reasons = new Set<string>();
  const tree = parser.parse(markdown);
  function visit(node: { type: string; checked?: boolean | null; meta?: string | null; children?: typeof tree.children }) {
    if (node.type === "html") reasons.add("HTML");
    if (node.type === "image" || node.type === "imageReference") reasons.add("images");
    if (node.type === "listItem" && node.checked != null) reasons.add("task lists");
    if (node.type === "footnoteDefinition" || node.type === "footnoteReference") reasons.add("footnotes");
    if (node.type === "code" && node.meta) reasons.add("code metadata");
    node.children?.forEach(visit);
  }
  visit(tree);
  return reasons.size
    ? `This description contains ${[...reasons].join(", ")}. Use Markdown mode to preserve this content. Rich mode is unavailable until these constructs are removed.`
    : null;
}
