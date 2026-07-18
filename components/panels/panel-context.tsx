"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

export type PanelType = "experiment" | "opportunity" | "discovery-rail";

export type PanelState = {
  type: PanelType;
  id: string;
} | null;

type PanelContextValue = {
  panel: PanelState;
  openPanel: (type: PanelType, id: string) => void;
  closePanel: () => void;
  orgSlug: string;
  workspaceSlug: string;
};

const PanelContext = createContext<PanelContextValue | null>(null);

export function PanelProvider({
  children,
  orgSlug,
  workspaceSlug,
}: {
  children: React.ReactNode;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const [panel, setPanel] = useState<PanelState>(null);

  const openPanel = useCallback((type: PanelType, id: string) => {
    setPanel({ type, id });
  }, []);

  const closePanel = useCallback(() => {
    setPanel(null);
  }, []);

  return (
    <PanelContext.Provider value={{ panel, openPanel, closePanel, orgSlug, workspaceSlug }}>
      {children}
    </PanelContext.Provider>
  );
}

export function usePanelContext() {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error("usePanelContext must be used inside PanelProvider");
  return ctx;
}
