import { StatusBadge } from "@/components/patterns/status-badge";
import {
  ROADMAP_DELIVERY_STATUS_LABELS,
  type RoadmapDeliveryStatus,
} from "@/lib/roadmap-delivery-status";

const BADGE_VARIANT: Record<
  RoadmapDeliveryStatus,
  "neutral" | "info" | "warning" | "danger" | "success"
> = {
  NOT_STARTED: "neutral",
  IN_DEVELOPMENT: "info",
  IN_REVIEW: "warning",
  BLOCKED: "danger",
  COMPLETE: "success",
};

export function DeliveryStatusBadge({ status }: { status: RoadmapDeliveryStatus }) {
  const label = ROADMAP_DELIVERY_STATUS_LABELS[status];
  return (
    <StatusBadge status={BADGE_VARIANT[status]} aria-label={`Delivery status: ${label}`}>
      {label}
    </StatusBadge>
  );
}
