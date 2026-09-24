import { loadUpdates } from "./actions";
import { UpdatesFeed } from "@/components/updates/updates-feed";
export default async function UpdatesPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const initial = await loadUpdates(orgSlug, workspaceSlug, "unread");
  return (
    <UpdatesFeed
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      initial={initial}
    />
  );
}
