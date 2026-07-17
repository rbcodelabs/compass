import { Badge } from "@/components/ui/badge";

type Props = {
  count: number;
  sourceCount?: number;
  className?: string;
};

/**
 * Shared "Backed by N signals [from M sources]" rollup badge.
 * Renders nothing when there is no evidence, so callers can render
 * unconditionally: <EvidenceBadge count={...} sourceCount={...} />.
 */
export function EvidenceBadge({ count, sourceCount, className }: Props) {
  if (count <= 0) return null;

  return (
    <Badge variant="secondary" className={className}>
      Backed by {count} {count === 1 ? "signal" : "signals"}
      {sourceCount ? ` from ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : ""}
    </Badge>
  );
}
