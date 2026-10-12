"use client";

import type { CSSProperties } from "react";
import { paceVerdict, type StatusMix } from "@/lib/okr-cycle-rollup";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import "./okrs-gallery.css";

/**
 * Presentational pieces shared by the OKRs index, the cycle detail banner and
 * the key-result panel. Client components (they read the thinking-model labels);
 * all time-dependent numbers arrive as props (computed once on the
 * server) so there is no hydration drift.
 */

export type MixTone = "ok" | "risk" | "off" | "done";

export const STATUS_MIX_ORDER: ReadonlyArray<{ key: keyof StatusMix; tone: MixTone; label: string }> = [
  { key: "ON_TRACK", tone: "ok", label: "On track" },
  { key: "AT_RISK", tone: "risk", label: "At risk" },
  { key: "OFF_TRACK", tone: "off", label: "Off track" },
  { key: "COMPLETE", tone: "done", label: "Complete" },
];

export function formatDateRange(start: Date | string, end: Date | string): string {
  const fmt = (d: Date | string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}

type RingStyle = CSSProperties & { "--p": number };

/** Conic progress ring with the percentage in the middle. */
export function ProgressRing({ progress, caption = "avg", size = "md" }: { progress: number; caption?: string; size?: "sm" | "md" }) {
  const style: RingStyle = { "--p": progress };
  return (
    <div className="okx-ring-wrap" data-size={size} role="img" aria-label={`${progress}% average progress`}>
      <div className="okx-ring" style={style} />
      <div className="okx-ring-label" aria-hidden="true">
        <strong>
          {progress}
          <small>%</small>
        </strong>
        <span>{caption}</span>
      </div>
    </div>
  );
}

/** Compact ring with the percentage inside, for objective card headers. */
export function MiniRing({ progress }: { progress: number }) {
  const style: RingStyle = { "--p": progress };
  return (
    <div className="okx-mring" role="img" aria-label={`${progress}% average progress`}>
      <div className="okx-ring" style={style} />
      <span className="okx-mring-label" aria-hidden="true">
        {progress}%
      </span>
    </div>
  );
}

/** Progress bar, optionally with a "today" tick showing how far through the cycle we are. */
export function PaceTrack({ progress, elapsed, legend = false, small = false }: { progress: number; elapsed?: number | null; legend?: boolean; small?: boolean }) {
  const labels = useLabels();
  const hasElapsed = elapsed != null;
  return (
    <>
      <div
        className={small ? "okx-track okx-track-sm" : "okx-track"}
        role="img"
        aria-label={`${progress}% progress${hasElapsed ? `, ${elapsed}% of time elapsed` : ""}`}
      >
        <div className="okx-track-fill" style={{ width: `${progress}%` }} />
        {hasElapsed && <div className="okx-track-tick" style={{ left: `${elapsed}%` }} />}
      </div>
      {legend && (
        <div className="okx-track-legend" aria-hidden="true">
          <span>
            <i />
            {labels.keyResult.singular} progress
          </span>
          {hasElapsed && (
            <span>
              <i className="okx-t" />
              Today
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** "12 pts behind pace · 53% of time elapsed" */
export function PaceNote({ progress, elapsed }: { progress: number; elapsed: number }) {
  const delta = progress - elapsed;
  const verdict = paceVerdict(progress, elapsed, 3);
  return (
    <span className="okx-pace-note">
      {verdict === "on-pace" ? (
        <b>On pace</b>
      ) : (
        <b className={verdict === "behind" ? "okx-behind" : "okx-ahead"}>
          {Math.abs(delta)} pts {verdict === "behind" ? "behind" : "ahead of"} pace
        </b>
      )}{" "}
      · {elapsed}% of time elapsed
    </span>
  );
}

/** Pills for each non-zero objective status. */
export function StatusChips({ mix }: { mix: StatusMix }) {
  const shown = STATUS_MIX_ORDER.filter((s) => mix[s.key] > 0);
  if (shown.length === 0) return null;
  return (
    <ul className="okx-chips" aria-label="Status" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {shown.map((s) => (
        <li key={s.key} className="okx-chip" data-tone={s.tone}>
          <b>{mix[s.key]}</b> {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Segmented bar + legend of objectives by status. */
export function StatusMixBar({ mix, title }: { mix: StatusMix; title: string }) {
  const shown = STATUS_MIX_ORDER.filter((s) => mix[s.key] > 0);
  return (
    <div className="okx-mix">
      <span className="okx-eyebrow">{title}</span>
      <div className="okx-mix-bar" aria-hidden="true">
        {shown.map((s) => (
          <span key={s.key} data-tone={s.tone} style={{ flex: mix[s.key] }} title={`${s.label}: ${mix[s.key]}`} />
        ))}
      </div>
      <div className="okx-legend">
        {STATUS_MIX_ORDER.map((s) => (
          <div key={s.key} data-tone={s.tone}>
            <i />
            {s.label}
            <b>{mix[s.key]}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
