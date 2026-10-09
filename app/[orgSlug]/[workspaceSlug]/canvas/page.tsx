import { redirect } from "next/navigation";

/**
 * The read-only OST canvas screen was retired: the same tree is now built on demand
 * inside a JSON Canvas doc ("Build tree" in the canvas editor toolbar), where it can be
 * dragged, grouped and saved. Old bookmarks and links land on the Docs library.
 */
export default async function LegacyCanvasPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(`/${orgSlug}/${workspaceSlug}/docs`);
}
