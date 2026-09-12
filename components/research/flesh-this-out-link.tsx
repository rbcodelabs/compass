import Link from "next/link"

export function FleshThisOutLink({ orgSlug, workspaceSlug, targetType, targetId }: { orgSlug: string; workspaceSlug: string; targetType: "OPPORTUNITY" | "SOLUTION" | "ASSUMPTION" | "EXPERIMENT"; targetId: string }) {
  return <Link className="inline-flex w-fit items-center rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted" href={`/${orgSlug}/${workspaceSlug}/capture/pm/new?targetType=${targetType}&targetId=${targetId}`}>Refine</Link>
}
