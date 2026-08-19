"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FacetedFilterMenu } from "@/components/patterns/faceted-filter-menu";
import type { SquadData } from "@/lib/types";

export function RoadmapFilters({ squads }: { squads: SquadData[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSquad = searchParams.get("squad");

  function setSquad(value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("squad", value);
    } else {
      params.delete("squad");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("squad");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  if (squads.length === 0) return null;

  return (
    <FacetedFilterMenu
      onClearAll={clearAll}
      groups={[
        {
          id: "squad",
          label: "Squad",
          value: activeSquad,
          onValueChange: setSquad,
          options: squads.map((squad) => ({
            value: squad.id,
            label: squad.name,
            color: squad.color,
          })),
        },
      ]}
    />
  );
}
