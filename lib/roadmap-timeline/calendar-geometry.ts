export type CalendarDate = `${number}-${number}-${number}` | string;

export type TimelineDateRange = {
  start: CalendarDate;
  end: CalendarDate;
};

const DAY_IN_MILLISECONDS = 86_400_000;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function calendarDateToUtcMilliseconds(date: CalendarDate): number {
  if (!CALENDAR_DATE_PATTERN.test(date)) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }

  const [year, month, day] = date.split("-").map(Number);
  const milliseconds = Date.UTC(year, month - 1, day);
  if (formatCalendarDate(milliseconds) !== date) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }

  return milliseconds;
}

export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  if (!Number.isInteger(days)) {
    throw new RangeError("Calendar day offset must be an integer");
  }
  return formatCalendarDate(calendarDateToUtcMilliseconds(date) + days * DAY_IN_MILLISECONDS);
}

export function inclusiveDayCount(start: CalendarDate, end: CalendarDate): number {
  const startTime = calendarDateToUtcMilliseconds(start);
  const endTime = calendarDateToUtcMilliseconds(end);
  if (endTime < startTime) {
    throw new RangeError("Timeline range end must not precede its start");
  }
  return (endTime - startTime) / DAY_IN_MILLISECONDS + 1;
}

export function dateToTimelinePosition(
  date: CalendarDate,
  viewportStart: CalendarDate,
  viewportEndExclusive: CalendarDate,
  width: number,
): number {
  assertPositiveFiniteWidth(width);
  const startTime = calendarDateToUtcMilliseconds(viewportStart);
  const endTime = calendarDateToUtcMilliseconds(viewportEndExclusive);
  if (endTime <= startTime) {
    throw new RangeError("Timeline viewport must have a positive date span");
  }
  return ((calendarDateToUtcMilliseconds(date) - startTime) / (endTime - startTime)) * width;
}

export function positionToTimelineDate(
  position: number,
  viewportStart: CalendarDate,
  viewportEndExclusive: CalendarDate,
  width: number,
): CalendarDate {
  if (!Number.isFinite(position)) {
    throw new RangeError("Timeline position must be finite");
  }
  assertPositiveFiniteWidth(width);
  const spanDays = exclusiveViewportDayCount(viewportStart, viewportEndExclusive);
  const boundedPosition = Math.max(0, Math.min(width, position));
  return addCalendarDays(viewportStart, Math.round((boundedPosition / width) * spanDays));
}

export function positionToInclusiveCalendarDate(
  position: number,
  viewportStart: CalendarDate,
  viewportEndExclusive: CalendarDate,
  width: number,
): CalendarDate {
  const projectedDate = positionToTimelineDate(position, viewportStart, viewportEndExclusive, width);
  const lastInclusiveDate = addCalendarDays(viewportEndExclusive, -1);
  return projectedDate > lastInclusiveDate ? lastInclusiveDate : projectedDate;
}

export function clampTimelineRange(
  start: CalendarDate,
  end: CalendarDate,
  viewportStart: CalendarDate,
  viewportEndInclusive: CalendarDate,
): TimelineDateRange {
  const duration = inclusiveDayCount(start, end);
  const viewportDuration = inclusiveDayCount(viewportStart, viewportEndInclusive);
  // An overlong range cannot preserve its duration inside the viewport, so this
  // operation intentionally truncates it to the full viewport. Renderers must
  // not use this move-oriented helper for passive display unless truncation is
  // the intended product behavior.
  if (duration > viewportDuration) {
    return { start: viewportStart, end: viewportEndInclusive };
  }
  if (calendarDateToUtcMilliseconds(start) < calendarDateToUtcMilliseconds(viewportStart)) {
    return { start: viewportStart, end: addCalendarDays(viewportStart, duration - 1) };
  }
  if (calendarDateToUtcMilliseconds(end) > calendarDateToUtcMilliseconds(viewportEndInclusive)) {
    return {
      start: addCalendarDays(viewportEndInclusive, -(duration - 1)),
      end: viewportEndInclusive,
    };
  }
  return { start, end };
}

export function resizeTimelineRange(
  start: CalendarDate,
  end: CalendarDate,
  edge: "left" | "right",
  date: CalendarDate,
): TimelineDateRange {
  inclusiveDayCount(start, end);
  const dateTime = calendarDateToUtcMilliseconds(date);
  if (edge === "left") {
    return { start: dateTime > calendarDateToUtcMilliseconds(end) ? end : date, end };
  }
  return { start, end: dateTime < calendarDateToUtcMilliseconds(start) ? start : date };
}

export function timelinePixelDeltaToDays(delta: number, dayWidth: number): number {
  if (!Number.isFinite(delta) || !Number.isFinite(dayWidth) || dayWidth <= 0) return 0;
  return Math.round(delta / dayWidth);
}

function exclusiveViewportDayCount(start: CalendarDate, endExclusive: CalendarDate): number {
  const startTime = calendarDateToUtcMilliseconds(start);
  const endTime = calendarDateToUtcMilliseconds(endExclusive);
  if (endTime <= startTime) {
    throw new RangeError("Timeline viewport must have a positive date span");
  }
  return (endTime - startTime) / DAY_IN_MILLISECONDS;
}

function formatCalendarDate(milliseconds: number): CalendarDate {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function assertPositiveFiniteWidth(width: number): void {
  if (!Number.isFinite(width) || width <= 0) {
    throw new RangeError("Timeline width must be a positive finite number");
  }
}
