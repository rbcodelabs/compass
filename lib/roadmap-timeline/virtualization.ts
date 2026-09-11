export type TimelineRenderWindow = {
  start: number;
  end: number;
};

const MAXIMUM_OVERSCAN_RATIO = 0.25;

export function calculateTimelineRenderWindow(
  scrollLeft: number,
  viewportWidth: number,
  canvasWidth: number,
  requestedOverscan = viewportWidth * MAXIMUM_OVERSCAN_RATIO,
): TimelineRenderWindow {
  if (
    !Number.isFinite(scrollLeft)
    || !Number.isFinite(viewportWidth)
    || !Number.isFinite(canvasWidth)
    || viewportWidth <= 0
    || canvasWidth <= 0
  ) {
    return { start: 0, end: 0 };
  }

  const maximumScrollLeft = Math.max(0, canvasWidth - viewportWidth);
  const boundedScrollLeft = Math.max(0, Math.min(scrollLeft, maximumScrollLeft));
  const maximumOverscan = viewportWidth * MAXIMUM_OVERSCAN_RATIO;
  const overscan = Number.isNaN(requestedOverscan)
    ? 0
    : Math.max(0, Math.min(requestedOverscan, maximumOverscan));

  return {
    start: Math.max(0, boundedScrollLeft - overscan),
    end: Math.min(canvasWidth, boundedScrollLeft + viewportWidth + overscan),
  };
}

export function isTimelineIntervalRendered(
  intervalStart: number,
  intervalEnd: number,
  renderWindow: TimelineRenderWindow,
): boolean {
  return Number.isFinite(intervalStart)
    && Number.isFinite(intervalEnd)
    && Number.isFinite(renderWindow.start)
    && Number.isFinite(renderWindow.end)
    && renderWindow.end > renderWindow.start
    && intervalEnd > intervalStart
    && intervalEnd > renderWindow.start
    && intervalStart < renderWindow.end;
}

export function selectTimelineIntervalsForRender<T>(
  intervals: readonly T[],
  renderWindow: TimelineRenderWindow,
  getInterval: (interval: T) => { id: string; start: number; end: number },
  retainedIds: ReadonlySet<string> = new Set(),
): T[] {
  const geometryIds = new Set<string>();
  return intervals.map((interval) => {
    const geometry = getInterval(interval);
    if (geometry.id.trim().length === 0) {
      throw new RangeError("Timeline geometry ID must not be empty");
    }
    if (geometryIds.has(geometry.id)) {
      throw new RangeError(`Duplicate timeline geometry ID: ${geometry.id}`);
    }
    geometryIds.add(geometry.id);
    return { interval, geometry };
  }).filter(({ geometry }) => {
    const hasValidGeometry = Number.isFinite(geometry.start)
      && Number.isFinite(geometry.end)
      && geometry.end > geometry.start;
    return hasValidGeometry && (
      retainedIds.has(geometry.id)
      || (isValidRenderWindow(renderWindow)
        && isTimelineIntervalRendered(geometry.start, geometry.end, renderWindow))
    );
  }).map(({ interval }) => interval);
}

function isValidRenderWindow(renderWindow: TimelineRenderWindow): boolean {
  return Number.isFinite(renderWindow.start)
    && Number.isFinite(renderWindow.end)
    && renderWindow.end > renderWindow.start;
}
