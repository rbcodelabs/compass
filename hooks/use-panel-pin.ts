"use client";

import { useCallback, useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  DEFAULT_PANEL_PIN,
  PANEL_PIN_MEDIA_QUERY,
  clampPanelWidth,
  panelPinCookieString,
  type PanelId,
  type PanelPin,
} from "@/lib/panel-pin";

/** Server-seeded preference; environmental suspension never rewrites it. */
export function usePanelPin(
  panelId: PanelId,
  initialPin: PanelPin = DEFAULT_PANEL_PIN,
) {
  const [pinned, setPinned] = useState(initialPin.pinned);
  const [width, setWidth] = useState(() => clampPanelWidth(initialPin.width));
  // Match the server's pin preference during hydration. Each surface also
  // applies a CSS breakpoint gate so a narrow screen cannot paint the aside.
  const viewportAllowsPin = useMediaQuery(PANEL_PIN_MEDIA_QUERY, pinned);
  const persist = useCallback((next: PanelPin) => {
    document.cookie = panelPinCookieString(panelId, next);
  }, [panelId]);
  const togglePinned = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    persist({ pinned: next, width });
  }, [persist, pinned, width]);
  // Persists the *current* pin flag. A resize used to imply pinned (the handle
  // only existed on a pinned panel), but the feedback composer also docks as a
  // column for unpinned users, and resizing it must not silently pin every
  // detail panel they open afterwards.
  const commitWidth = useCallback((next: number) => {
    const clamped = clampPanelWidth(next);
    setWidth(clamped);
    persist({ pinned, width: clamped });
    window.dispatchEvent(new Event("resize"));
  }, [persist, pinned]);
  return {
    pinned,
    width,
    viewportAllowsPin,
    isPinnedMode: pinned && viewportAllowsPin,
    togglePinned,
    commitWidth,
  };
}
