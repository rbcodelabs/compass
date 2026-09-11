"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "board" | "timeline";

export function RoadmapViewToggle({ view }: { view: View }) {
  const { set } = useUrlState();

  function setView(next: string) {
    // "board" is the default view, so it is represented by the absence of the
    // param rather than `?view=board`.
    set({ view: next === "timeline" ? "timeline" : null });
  }

  return (
    <Tabs value={view} onValueChange={(value) => setView(value as string)}>
      <TabsList className="min-h-[50px] md:min-h-0">
        <TabsTrigger className="min-h-11 md:min-h-0" value="board">Board</TabsTrigger>
        <TabsTrigger className="min-h-11 md:min-h-0" value="timeline">Timeline</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
