"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { CreateFeedbackDialog } from "@/components/feedback/create-feedback-dialog";

type FeedbackHeaderActionsProps = {
  orgSlug: string;
  workspaceSlug: string;
};

export function FeedbackHeaderActions({
  orgSlug,
  workspaceSlug,
}: FeedbackHeaderActionsProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [toolbarHostReady, setToolbarHostReady] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setToolbarHostReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      {toolbarHostReady && (
        <div id="feedback-header-toolbar" className="min-w-0 flex-1" />
      )}
      <CreateFeedbackDialog
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        revalidatePathStr={pathname}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
