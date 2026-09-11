"use client";

import { RelationList, Section } from "@/components/panels/panel-parts";
import { feedbackStatusLabel, feedbackStatusTone, FEEDBACK_TONE_CLASS } from "@/lib/feedback-meta";

export type LinkedFeedbackItem = { id: string; title: string; type: string; status: string };

/** The same source relationships are available on the full page and in its panel. */
export function LinkedFeedback({ feedback }: { feedback: LinkedFeedbackItem[] }) {
  return (
    <Section label={`Linked feedback (${feedback.length})`}>
      <RelationList
        items={feedback.map((item) => ({
          type: "feedback",
          id: item.id,
          title: item.title,
          badge: {
            label: feedbackStatusLabel(item.status),
            className: FEEDBACK_TONE_CLASS[feedbackStatusTone(item.status)],
          },
        }))}
        empty="No feedback linked."
      />
    </Section>
  );
}
