"use client";

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

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div id="feedback-header-toolbar" className="min-w-0 flex-1" />
      <CreateFeedbackDialog
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        revalidatePathStr={pathname}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
