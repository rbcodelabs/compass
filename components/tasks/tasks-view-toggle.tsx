"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "board" | "list";

export function TasksViewToggle({ view }: { view: View }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setView(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "list") {
      params.set("view", "list");
    } else {
      params.delete("view");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
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
