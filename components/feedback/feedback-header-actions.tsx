"use client";

import { useEffect, useState } from "react";

import { NewFeedbackButton } from "@/components/feedback/new-feedback-button";

export function FeedbackHeaderActions() {
  const [toolbarHostReady, setToolbarHostReady] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setToolbarHostReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      {toolbarHostReady && (
        <div id="feedback-header-toolbar" className="min-w-0 flex-1" />
      )}
      <NewFeedbackButton />
    </div>
  );
}
