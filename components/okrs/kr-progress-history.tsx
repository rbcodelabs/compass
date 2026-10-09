"use client";

import { paceVerdict } from "@/lib/okr-cycle-rollup";
import { PaceNote, PaceTrack } from "./okr-visuals";

export interface CheckInPoint {
  id: string;
  value: number;
  note: string | null;
  createdAt: string;
}

interface KrHeroProps {
  current: number;
  target: number;
  unit: string | null;
  /** Percent of the owning cycle elapsed; null when there is no running cycle to pace against. */
  elapsed: number | null;
}

/** Big current/target figure with a pace-aware progress track. */
export function KrHero({ current, target, unit, elapsed }: KrHeroProps) {
  const pct = target > 0 ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : 0;
  const u = unit ? ` ${unit}` : "";
  return (
    <div className="okx-kr-hero" data-testid="kr-hero">
      <div className="okx-kr-big">
        <strong>{current}</strong>
        <span>
          of {target}
          {u}
        </span>
        <em>{target > 0 ? `${pct}%` : "–"}</em>
      </div>
      <PaceTrack progress={pct} elapsed={elapsed} legend={elapsed != null} />
      {elapsed != null && target > 0 && paceVerdict(pct, elapsed, 3) !== "on-pace" ? (
        <PaceNote progress={pct} elapsed={elapsed} />
      ) : null}
    </div>
  );
}

const W = 320;
const H = 110;
const PAD = { l: 8, r: 8, t: 10, b: 12 };

/** Check-in values over time against the target, with a straight-line pace when the cycle has dates. */
export function KrSparkline({
  points,
  target,
  cycle,
  now,
}: {
  points: CheckInPoint[];
  target: number;
  cycle: { startDate: string; endDate: string } | null;
  now: number;
}) {
  const pts = [...points]
    .map((p) => ({ t: new Date(p.createdAt).getTime(), v: p.value }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;

  const cStart = cycle ? new Date(cycle.startDate).getTime() : null;
  const cEnd = cycle ? new Date(cycle.endDate).getTime() : null;
  const hasCycle = cStart != null && cEnd != null && cEnd > cStart;
  let t0 = hasCycle ? cStart : pts[0].t;
  let t1 = hasCycle ? cEnd : Math.max(pts[pts.length - 1].t, now);
  t0 = Math.min(t0, pts[0].t);
  t1 = Math.max(t1, pts[pts.length - 1].t);
  if (t1 === t0) t1 = t0 + 1;

  const vMin = Math.min(0, ...pts.map((p) => p.v));
  const vMax = Math.max(target, ...pts.map((p) => p.v), vMin + 1);
  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - vMin) / (vMax - vMin)) * (H - PAD.t - PAD.b);

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1].t).toFixed(1)} ${y(vMin).toFixed(1)} L${x(pts[0].t).toFixed(1)} ${y(vMin).toFixed(1)} Z`;
  const showToday = hasCycle && now >= t0 && now <= t1;

  return (
    <div className="okx-psec">
      <svg
        className="okx-spark"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Check-in history: ${pts.length} ${pts.length === 1 ? "check-in" : "check-ins"}, latest ${pts[pts.length - 1].v} of ${target}`}
      >
        <line className="okx-sp-target" x1={PAD.l} x2={W - PAD.r} y1={y(target)} y2={y(target)} />
        {hasCycle && <line className="okx-sp-pace" x1={x(cStart)} y1={y(0)} x2={x(cEnd)} y2={y(target)} />}
        {showToday && <line className="okx-sp-today" x1={x(now)} x2={x(now)} y1={PAD.t - 4} y2={H - PAD.b + 4} />}
        {pts.length > 1 && <path className="okx-sp-area" d={area} />}
        {pts.length > 1 && <path className="okx-sp-line" d={line} />}
        {pts.map((p, i) => (
          <circle key={i} className="okx-sp-dot" cx={x(p.t)} cy={y(p.v)} r={3.5} />
        ))}
      </svg>
      <div className="okx-spark-legend" aria-hidden="true">
        <span>
          <i />
          Check-ins
        </span>
        {hasCycle && (
          <span>
            <i className="p" />
            Pace to target
          </span>
        )}
        {showToday && (
          <span>
            <i className="t" />
            Today
          </span>
        )}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Newest-first list of check-ins with the change from the previous one. `points` must be newest-first. */
export function CheckInHistory({ points, unit }: { points: CheckInPoint[]; unit: string | null }) {
  if (points.length === 0) return <p className="okx-empty">No check-ins yet.</p>;
  const u = unit ? ` ${unit}` : "";
  return (
    <ol className="okx-ci-list" aria-label="Check-in history">
      {points.map((p, i) => {
        const prev = points[i + 1];
        const delta = prev ? p.value - prev.value : null;
        return (
          <li key={p.id}>
            <span className="okx-ci-dot" aria-hidden="true" />
            <div className="okx-ci-body">
              <div className="okx-ci-top">
                <b>
                  {p.value}
                  {u}
                </b>
                {delta != null && delta !== 0 && (
                  <span className="okx-ci-delta" data-dir={delta > 0 ? "up" : "down"}>
                    {delta > 0 ? "+" : "−"}
                    {Math.abs(Math.round(delta * 100) / 100)}
                  </span>
                )}
                <time dateTime={p.createdAt}>{formatWhen(p.createdAt)}</time>
              </div>
              {p.note && <p>{p.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
