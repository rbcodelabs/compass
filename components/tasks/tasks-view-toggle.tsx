"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "board" | "list";

export function TasksViewToggle({ view }: { view: View }) {
  const { set } = useUrlState();

  function setView(next: string) {
    // "board" is the default view, so it is represented by the absence of the
    // param rather than `?view=board`.
    set({ view: next === "list" ? "list" : null });
  }

  return (
    <Tabs value={view} onValueChange={(value) => setView(value as string)}>
      <TabsList>
        <TabsTrigger value="board">Board</TabsTrigger>
        <TabsTrigger value="list">List</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
