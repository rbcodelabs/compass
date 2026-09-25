import { File as FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FeedbackAttachmentData = {
  id: string;
  url: string;
  filename: string;
  fileType: string;
};

interface Props {
  attachments: FeedbackAttachmentData[];
  /**
   * `sm` (default) is the dense strip used in grid rows and portal cards.
   * `lg` is for the detail panel, where there is room to actually see a
   * screenshot and read file names.
   */
  size?: "sm" | "lg";
}

/**
 * Read-only display of a feedback item's attachments — a thumbnail grid for
 * images, file chips (icon + filename) for everything else. Each opens the
 * blob URL in a new tab. Shared between the public portal list and the
 * internal triage board so attachment presentation stays consistent.
 */
export function FeedbackAttachments({ attachments, size = "sm" }: Props) {
  if (attachments.length === 0) return null;
  const large = size === "lg";

  return (
    <div className={cn("flex flex-wrap items-center", large ? "gap-2" : "gap-1.5 mt-1")}>
      {attachments.map((a) =>
        a.fileType.startsWith("image/") ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "block rounded-md border border-border-default overflow-hidden shrink-0 hover:border-border-strong transition-colors",
              large ? "w-24 h-24" : "w-10 h-10",
            )}
            title={a.filename}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.filename} className="w-full h-full object-cover" />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center gap-1 rounded-md border border-border-default bg-surface-app px-2 py-1 text-xs text-text-secondary hover:bg-surface-inset hover:border-border-strong transition-colors",
              large ? "max-w-full" : "max-w-[10rem]",
            )}
            title={a.filename}
          >
            <FileIcon className="w-3 h-3 shrink-0 text-text-subtle" />
            <span className="truncate">{a.filename}</span>
          </a>
        )
      )}
    </div>
  );
}
