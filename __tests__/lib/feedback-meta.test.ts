import { describe, expect, it } from "vitest";
import {
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_META,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_META,
  feedbackStatusLabel,
  feedbackStatusTone,
  feedbackTypeIcon,
  feedbackTypeLabel,
  feedbackTypeTone,
  formatFeedbackDate,
  isFeedbackStatus,
  isFeedbackType,
  type FeedbackTone,
} from "@/lib/feedback-meta";

// The five variants `components/patterns/status-badge.tsx` actually accepts.
const STATUS_BADGE_TONES: FeedbackTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
];

describe("feedback-meta: statuses", () => {
  it("covers exactly the six product statuses", () => {
    expect([...FEEDBACK_STATUSES]).toEqual([
      "OPEN",
      "UNDER_REVIEW",
      "PLANNED",
      "IN_PROGRESS",
      "COMPLETED",
      "DECLINED",
    ]);
    expect(Object.keys(FEEDBACK_STATUS_META).sort()).toEqual(
      [...FEEDBACK_STATUSES].sort(),
    );
  });

  it("gives every status a label and a StatusBadge-compatible tone", () => {
    for (const status of FEEDBACK_STATUSES) {
      const meta = FEEDBACK_STATUS_META[status];
      expect(meta.value).toBe(status);
      expect(meta.label).toBeTruthy();
      expect(meta.label).not.toBe(status);
      expect(STATUS_BADGE_TONES).toContain(meta.tone);
    }
  });

  it("uses the agreed status -> tone mapping", () => {
    expect(feedbackStatusTone("OPEN")).toBe("neutral");
    expect(feedbackStatusTone("UNDER_REVIEW")).toBe("warning");
    expect(feedbackStatusTone("PLANNED")).toBe("info");
    expect(feedbackStatusTone("IN_PROGRESS")).toBe("info");
    expect(feedbackStatusTone("COMPLETED")).toBe("success");
    expect(feedbackStatusTone("DECLINED")).toBe("danger");
  });

  it("uses the agreed status labels", () => {
    expect(feedbackStatusLabel("OPEN")).toBe("Open");
    expect(feedbackStatusLabel("UNDER_REVIEW")).toBe("Under review");
    expect(feedbackStatusLabel("PLANNED")).toBe("Planned");
    expect(feedbackStatusLabel("IN_PROGRESS")).toBe("In progress");
    expect(feedbackStatusLabel("COMPLETED")).toBe("Completed");
    expect(feedbackStatusLabel("DECLINED")).toBe("Declined");
  });

  it("falls back to the raw value for an unknown status instead of throwing", () => {
    expect(feedbackStatusLabel("ARCHIVED")).toBe("ARCHIVED");
    expect(feedbackStatusTone("ARCHIVED")).toBe("neutral");
  });
});

describe("feedback-meta: types", () => {
  it("covers exactly IDEA and BUG", () => {
    expect([...FEEDBACK_TYPES]).toEqual(["IDEA", "BUG"]);
    expect(Object.keys(FEEDBACK_TYPE_META).sort()).toEqual(["BUG", "IDEA"]);
  });

  it("gives every type a label, tone and icon NAME (never a component)", () => {
    for (const type of FEEDBACK_TYPES) {
      const meta = FEEDBACK_TYPE_META[type];
      expect(meta.value).toBe(type);
      expect(meta.label).toBeTruthy();
      expect(STATUS_BADGE_TONES).toContain(meta.tone);
      // Icons must be serialisable strings so the module stays server-safe.
      expect(typeof meta.icon).toBe("string");
    }
    expect(feedbackTypeLabel("BUG")).toBe("Bug");
    expect(feedbackTypeLabel("IDEA")).toBe("Idea");
    expect(feedbackTypeTone("BUG")).toBe("danger");
    expect(feedbackTypeTone("IDEA")).toBe("info");
    expect(feedbackTypeIcon("BUG")).toBe("bug");
    expect(feedbackTypeIcon("IDEA")).toBe("lightbulb");
  });

  it("falls back for an unknown type", () => {
    expect(feedbackTypeLabel("QUESTION")).toBe("QUESTION");
    expect(feedbackTypeTone("QUESTION")).toBe("neutral");
    expect(feedbackTypeIcon("QUESTION")).toBeUndefined();
  });
});

describe("feedback-meta: type guards", () => {
  it("accepts every known value", () => {
    for (const status of FEEDBACK_STATUSES) expect(isFeedbackStatus(status)).toBe(true);
    for (const type of FEEDBACK_TYPES) expect(isFeedbackType(type)).toBe(true);
  });

  it("rejects junk of every shape", () => {
    const junk = [
      "",
      "open",
      "OPEN ",
      "BOGUS",
      "OPEN,BOGUS",
      "OPEN);DROP TABLE",
      "__proto__",
      "constructor",
      "toString",
      0,
      1,
      null,
      undefined,
      true,
      {},
      [],
      ["OPEN"],
      Symbol("OPEN"),
    ];
    for (const value of junk) {
      expect(isFeedbackStatus(value), `status guard on ${String(value)}`).toBe(false);
      expect(isFeedbackType(value), `type guard on ${String(value)}`).toBe(false);
    }
    // Cross-rejection: a valid type is not a valid status and vice versa.
    expect(isFeedbackStatus("BUG")).toBe(false);
    expect(isFeedbackType("OPEN")).toBe(false);
  });
});

describe("feedback-meta: formatFeedbackDate", () => {
  it("formats Date, ISO string and epoch identically", () => {
    const iso = "2026-08-26T15:04:05.000Z";
    const expected = new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(formatFeedbackDate(new Date(iso))).toBe(expected);
    expect(formatFeedbackDate(iso)).toBe(expected);
    expect(formatFeedbackDate(new Date(iso).getTime())).toBe(expected);
    expect(expected).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it("returns an empty string for unparseable input instead of 'Invalid Date'", () => {
    expect(formatFeedbackDate("not a date")).toBe("");
    expect(formatFeedbackDate(Number.NaN)).toBe("");
    expect(formatFeedbackDate(new Date("nope"))).toBe("");
  });
});
