"use client";

import { OpportunityDetail } from "@/components/discovery/opportunity-detail";

export function OpportunityPanel(props: { opportunityId: string; orgSlug: string; workspaceSlug: string }) {
  return <OpportunityDetail {...props} variant="panel" />;
}
