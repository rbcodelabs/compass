"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { SquadData } from "@/lib/types";

interface Props {
  squads: SquadData[];
}

export function SquadFilterBar({ squads }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeSquadId = searchParams.get("squad");

  if (squads.length === 0) return null;

  function setFilter(squadId: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (squadId) {
      params.set("squad", squadId);
    } else {
      params.delete("squad");
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground font-medium mr-1">Squad:</span>
      <button
        onClick={() => setFilter(null)}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
          !activeSquadId
            ? "bg-foreground text-background border-foreground"
            : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
        }`}
      >
        All
      </button>
      {squads.map((squad) => (
        <button
          key={squad.id}
          onClick={() => setFilter(squad.id === activeSquadId ? null : squad.id)}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
            activeSquadId === squad.id
              ? "border-transparent text-white"
              : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/40"
          }`}
          style={
            activeSquadId === squad.id
              ? { backgroundColor: squad.color, borderColor: squad.color }
              : {}
          }
        >
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: squad.color }}
          />
          {squad.name}
        </button>
      ))}
    </div>
  );
}
