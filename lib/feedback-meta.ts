/**
 * Single source of truth for feedback status/type presentation.
 *
 * Pure data — **no JSX, no React imports** — so this module can be imported by
 * server components, MCP tool handlers, and the pure `lib/feedback-query.ts`
 * parser alike. Icons are stored as *names* (`"bug"` / `"lightbulb"`), and the
 * rendering layer maps a name to a `lucide-react` component.
 *
 * Tones map 1:1 onto `components/patterns/status-badge.tsx`, which accepts a
 * `status` prop with exactly five variants.
 */

export const FEEDBACK_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "PLANNED",
  "IN_PROGRESS",
  "COMPLETED",
  "DECLINED",
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_TYPES = ["IDEA", "BUG"] as const;

export type FeedbackTypeValue = (typeof FEEDBACK_TYPES)[number];

/** The five `StatusBadge` variants. Do not mint new tones without a token pair. */
export type FeedbackTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

/** Icon *names*, not components, so this module stays free of JSX. */
export type FeedbackIconName = "bug" | "lightbulb";

export type FeedbackStatusMeta = {
  value: FeedbackStatus;
  label: string;
  tone: FeedbackTone;
};

export type FeedbackTypeMeta = {
  value: FeedbackTypeValue;
  label: string;
  tone: FeedbackTone;
  icon: FeedbackIconName;
};

export const FEEDBACK_STATUS_META: Record<FeedbackStatus, FeedbackStatusMeta> = {
  OPEN: { value: "OPEN", label: "Open", tone: "neutral" },
  UNDER_REVIEW: { value: "UNDER_REVIEW", label: "Under review", tone: "warning" },
  PLANNED: { value: "PLANNED", label: "Planned", tone: "info" },
  IN_PROGRESS: { value: "IN_PROGRESS", label: "In progress", tone: "info" },
  COMPLETED: { value: "COMPLETED", label: "Completed", tone: "success" },
  DECLINED: { value: "DECLINED", label: "Declined", tone: "danger" },
};

export const FEEDBACK_TYPE_META: Record<FeedbackTypeValue, FeedbackTypeMeta> = {
  IDEA: { value: "IDEA", label: "Idea", tone: "info", icon: "lightbulb" },
  BUG: { value: "BUG", label: "Bug", tone: "danger", icon: "bug" },
};

/**
 * Type guard for a feedback status. Also serves as the allowlist for the
 * `status` search param in `lib/feedback-query.ts` — a value that fails this
 * check never reaches Prisma.
 */
export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return (
    typeof value === "string" &&
    (FEEDBACK_STATUSES as readonly string[]).includes(value)
  );
}

/** Type guard for a feedback type. Doubles as the `type` search-param allowlist. */
export function isFeedbackType(value: unknown): value is FeedbackTypeValue {
  return (
    typeof value === "string" &&
    (FEEDBACK_TYPES as readonly string[]).includes(value)
  );
}

/** Label for a status, falling back to the raw value for forward compatibility. */
export function feedbackStatusLabel(value: string): string {
  return isFeedbackStatus(value) ? FEEDBACK_STATUS_META[value].label : value;
}

/** Tone for a status; unknown values render neutral rather than throwing. */
export function feedbackStatusTone(value: string): FeedbackTone {
  return isFeedbackStatus(value) ? FEEDBACK_STATUS_META[value].tone : "neutral";
}

/** Label for a type, falling back to the raw value. */
export function feedbackTypeLabel(value: string): string {
  return isFeedbackType(value) ? FEEDBACK_TYPE_META[value].label : value;
}

/** Tone for a type; unknown values render neutral rather than throwing. */
export function feedbackTypeTone(value: string): FeedbackTone {
  return isFeedbackType(value) ? FEEDBACK_TYPE_META[value].tone : "neutral";
}

/** Icon name for a type, or `undefined` for an unrecognised value. */
export function feedbackTypeIcon(value: string): FeedbackIconName | undefined {
  return isFeedbackType(value) ? FEEDBACK_TYPE_META[value].icon : undefined;
}

/**
 * Tokenised class pair per tone, for the handful of legacy call sites that take
 * a `className` string instead of rendering `<StatusBadge status=...>`
 * (`components/panels/panel-parts.tsx`). Semantic tokens only — raw palette
 * utilities fail `pnpm ui:colors`.
 */
export const FEEDBACK_TONE_CLASS: Record<FeedbackTone, string> = {
  neutral: "bg-status-neutral-surface text-status-neutral",
  info: "bg-status-info-surface text-status-info",
  success: "bg-status-success-surface text-status-success",
  warning: "bg-status-warning-surface text-status-warning",
  danger: "bg-status-danger-surface text-status-danger",
};

/** `{ label, className }` per status, shaped for `panel-parts`' `StatusOption`. */
export const FEEDBACK_STATUS_OPTIONS: Record<
  FeedbackStatus,
  { label: string; className: string }
> = Object.fromEntries(
  FEEDBACK_STATUSES.map((status) => [
    status,
    {
      label: FEEDBACK_STATUS_META[status].label,
      className: FEEDBACK_TONE_CLASS[FEEDBACK_STATUS_META[status].tone],
    },
  ]),
) as Record<FeedbackStatus, { label: string; className: string }>;

/** `{ label, className }` per type, shaped for `panel-parts`' `StatusOption`. */
export const FEEDBACK_TYPE_OPTIONS: Record<
  FeedbackTypeValue,
  { label: string; className: string }
> = Object.fromEntries(
  FEEDBACK_TYPES.map((type) => [
    type,
    {
      label: FEEDBACK_TYPE_META[type].label,
      className: FEEDBACK_TONE_CLASS[FEEDBACK_TYPE_META[type].tone],
    },
  ]),
) as Record<FeedbackTypeValue, { label: string; className: string }>;

/**
 * The one date format used across every feedback surface: "Aug 26, 2026".
 * Accepts a `Date`, an ISO string, or an epoch number. Invalid input returns
 * an empty string rather than "Invalid Date".
 */
export function formatFeedbackDate(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
