import { Link2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

type Props = {
  count: number;
  className?: string;
};

/**
 * Shared "Linked to N item(s)" rollup badge for a Task card/detail view.
 * Follows the exact pattern of EvidenceBadge — renders nothing when there
 * are no links, so callers can render unconditionally.
 */
export function TaskLinksBadge({ count, className }: Props) {
  if (count <= 0) return null;

  return (
    <Badge variant="secondary" className={className}>
      <Link2Icon className="size-3" />
      Linked to {count} {count === 1 ? "item" : "items"}
    </Badge>
  );
}
