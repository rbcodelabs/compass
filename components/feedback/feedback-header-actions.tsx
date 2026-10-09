"use client";

import { NewFeedbackButton } from "@/components/feedback/new-feedback-button";

/** Feedback's primary header action. The grid toolbar lives in the `toolbar` slot (see FEEDBACK_TOOLBAR_HOST_ID). */
export function FeedbackHeaderActions() {
  return <NewFeedbackButton />;
}
