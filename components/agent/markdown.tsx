import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

// Markdown renderer for agent messages. GitHub-flavored (tables, task lists,
// strikethrough, autolinks) via remark-gfm; XSS-safe (react-markdown renders
// React elements, no raw HTML). Styled entirely with design-system semantic
// tokens via descendant arbitrary-variants so it passes ui:colors, and without
// any literal native table tag in source so it passes ui:primitives.

const PROSE = [
  "text-sm leading-relaxed break-words",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  // paragraphs / spacing
  "[&_p]:my-2",
  // headings
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold",
  // lists
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_li>ul]:my-1 [&_li>ol]:my-1",
  // task lists (gfm)
  "[&_input[type=checkbox]]:mr-1.5 [&_li:has(input)]:list-none [&_li:has(input)]:-ml-5",
  // emphasis / links
  "[&_strong]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  // blockquote
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-default [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary",
  // inline code + code blocks
  "[&_code]:rounded [&_code]:bg-surface-inset [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-inset [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs",
  // tables (gfm)
  "[&_table]:my-2 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:border-default [&_th]:bg-surface-inset [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-default [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  // rules / images
  "[&_hr]:my-3 [&_hr]:border-default [&_img]:max-w-full [&_img]:rounded-lg",
].join(" ")

export function Markdown({ children }: { children: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}
