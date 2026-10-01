import { redirect } from "next/navigation";

// The card sort lives at /<org>/<workspace>/card-sort, but it is reached from
// Discovery, so /discovery/card-sort is the URL people guess. A static segment
// outranks [opportunityId], so this catches it before it is read as an id.
export default async function DiscoveryCardSortRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(`/${orgSlug}/${workspaceSlug}/card-sort`);
}
