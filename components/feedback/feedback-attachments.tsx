import { File as FileIcon } from "lucide-react";

export type FeedbackAttachmentData = {
  id: string;
  url: string;
  filename: string;
  fileType: string;
};

interface Props {
  attachments: FeedbackAttachmentData[];
}

/**
 * Read-only display of a feedback item's attachments — a thumbnail grid for
 * images, file chips (icon + filename) for everything else. Each opens the
 * blob URL in a new tab. Shared between the public portal list and the
 * internal triage board so attachment presentation stays consistent.
 */
export function FeedbackAttachments({ attachments }: Props) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1">
      {attachments.map((a) =>
        a.fileType.startsWith("image/") ? (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-md border border-slate-200 overflow-hidden w-10 h-10 shrink-0 hover:border-slate-300 transition-colors"
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
            className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 hover:border-slate-300 transition-colors max-w-[10rem]"
            title={a.filename}
          >
            <FileIcon className="w-3 h-3 shrink-0 text-slate-400" />
            <span className="truncate">{a.filename}</span>
          </a>
        )
      )}
    </div>
  );
}
