import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const PROSE = [
  "min-w-0 text-sm leading-relaxed break-words",
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
  "[&_p]:my-2 [&_p]:whitespace-pre-line",
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold",
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_li>ul]:my-1 [&_li>ol]:my-1",
  "[&_input[type=checkbox]]:mr-1.5 [&_li:has(input)]:list-none [&_li:has(input)]:-ml-5",
  "[&_strong]:font-semibold [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-default [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary",
  "[&_code]:rounded [&_code]:bg-surface-inset [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-surface-inset [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs",
  "[&_table]:my-2 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:border-default [&_th]:bg-surface-inset [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-default [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_hr]:my-3 [&_hr]:border-default",
].join(" ");

function safeUrl(url: string): string {
  return defaultUrlTransform(url);
}

export function MarkdownContent({ children, className }: { children: string | null | undefined; className?: string }) {
  return (
    <div className={cn(PROSE, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            const external = Boolean(href && /^(?:https?:)?\/\//i.test(href));
            return <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
          },
          img: () => null,
        }}
      >
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
