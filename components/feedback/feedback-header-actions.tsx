"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { CreateFeedbackDialog } from "@/components/feedback/create-feedback-dialog";
import { FacetedFilterMenu } from "@/components/patterns/faceted-filter-menu";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_META,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_META,
} from "@/lib/feedback-meta";

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
  const searchParams = useSearchParams();

  function setFilter(key: "status" | "type", value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("status");
    params.delete("type");
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <>
      <FacetedFilterMenu
        onClearAll={clearFilters}
        groups={[
          {
            id: "status",
            label: "Status",
            value: searchParams.get("status"),
            options: FEEDBACK_STATUSES.map((status) => ({
              value: status,
              label: FEEDBACK_STATUS_META[status].label,
            })),
            onValueChange: (value) => setFilter("status", value),
          },
          {
            id: "type",
            label: "Type",
            value: searchParams.get("type"),
            options: FEEDBACK_TYPES.map((type) => ({
              value: type,
              label: FEEDBACK_TYPE_META[type].label,
            })),
            onValueChange: (value) => setFilter("type", value),
          },
        ]}
      />
      <CreateFeedbackDialog
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        revalidatePathStr={pathname}
        onCreated={() => router.refresh()}
      />
    </>
  );
}
