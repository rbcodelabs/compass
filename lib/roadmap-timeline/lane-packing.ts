import {
  calendarDateToUtcMilliseconds,
  inclusiveDayCount,
  type CalendarDate,
} from "./calendar-geometry";

export type TimelineLaneKey = `${string}:${string}`;

export type TimelineInterval = {
  id: string;
  laneKey: TimelineLaneKey;
  start: CalendarDate;
  end: CalendarDate;
};

export type PackedTimelineInterval<T extends TimelineInterval> = T & {
  track: number;
  trackCount: number;
};

export function createTimelineLaneKey(horizonId: string, squadId: string | null): TimelineLaneKey {
  if (
    horizonId.trim().length === 0
    || horizonId !== horizonId.trim()
    || horizonId.includes(":")
    || (squadId !== null && squadId.trim().length === 0)
    || (squadId !== null && squadId !== squadId.trim())
    || squadId?.includes(":")
    || squadId === "unassigned"
  ) {
    throw new RangeError("Timeline lane parts must be non-empty and unambiguous");
  }
  return `${horizonId}:${squadId ?? "unassigned"}`;
}

export function packTimelineIntervals<T extends TimelineInterval>(
  intervals: readonly T[],
): Array<PackedTimelineInterval<T>> {
  const intervalIds = new Set<string>();
  const sortedIntervals = intervals.map((interval) => {
    if (interval.id.trim().length === 0) {
      throw new RangeError("Timeline interval ID must not be empty");
    }
    if (intervalIds.has(interval.id)) {
      throw new RangeError(`Duplicate timeline interval ID: ${interval.id}`);
    }
    intervalIds.add(interval.id);
    assertCanonicalLaneKey(interval.laneKey);
    inclusiveDayCount(interval.start, interval.end);
    return interval;
  }).sort(compareIntervals);

  const intervalsByLane = new Map<TimelineLaneKey, T[]>();
  for (const interval of sortedIntervals) {
    const laneIntervals = intervalsByLane.get(interval.laneKey) ?? [];
    laneIntervals.push(interval);
    intervalsByLane.set(interval.laneKey, laneIntervals);
  }

  return [...intervalsByLane.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .flatMap(([, laneIntervals]) => packLane(laneIntervals));
}

function assertCanonicalLaneKey(laneKey: TimelineLaneKey): void {
  const parts = laneKey.split(":");
  if (
    parts.length !== 2
    || parts[0].trim().length === 0
    || parts[1].trim().length === 0
    || parts[0] !== parts[0].trim()
    || parts[1] !== parts[1].trim()
  ) {
    throw new RangeError(`Invalid timeline lane key: ${laneKey}`);
  }
}

function packLane<T extends TimelineInterval>(
  intervals: readonly T[],
): Array<PackedTimelineInterval<T>> {
  // Lowest-track assignment is intentionally bounded by the 500-item readiness
  // corpus. Its stable track identity is more important here than a heap whose
  // ordering would not preserve the lowest reusable track.
  const trackEndTimes: number[] = [];
  const assignments = intervals.map((interval) => {
    const startTime = calendarDateToUtcMilliseconds(interval.start);
    let track = trackEndTimes.findIndex((endTime) => endTime < startTime);
    if (track === -1) track = trackEndTimes.length;
    trackEndTimes[track] = calendarDateToUtcMilliseconds(interval.end);
    return { interval, track };
  });

  return assignments.map(({ interval, track }) => ({
    ...interval,
    track,
    trackCount: trackEndTimes.length,
  }));
}

function compareIntervals(left: TimelineInterval, right: TimelineInterval): number {
  return compareStrings(left.laneKey, right.laneKey)
    || calendarDateToUtcMilliseconds(left.start) - calendarDateToUtcMilliseconds(right.start)
    || calendarDateToUtcMilliseconds(left.end) - calendarDateToUtcMilliseconds(right.end)
    || compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
