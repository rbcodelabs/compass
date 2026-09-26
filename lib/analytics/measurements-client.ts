import type { BindingDTO, MetricDTO, MetricTarget, ObservationDTO } from "@/lib/analytics/service";

export type Measurement = { binding: BindingDTO; observations: ObservationDTO[] };
export type MeasurementsData = { measurements: Measurement[]; metrics: MetricDTO[] };

/**
 * Client read for MeasurementsPanel via GET /api/analytics/measurements.
 * Never a server action — see that route for why reads must stay out of the
 * Next router's action queue.
 */
export async function loadMeasurements(orgSlug: string, workspaceSlug: string, target: MetricTarget): Promise<MeasurementsData> {
  const query = new URLSearchParams({ orgSlug, workspaceSlug, targetType: target.targetType, targetId: target.targetId });
  const response = await fetch(`/api/analytics/measurements?${query}`);
  if (!response.ok) throw new Error(`Measurements request failed (${response.status})`);
  return response.json() as Promise<MeasurementsData>;
}
