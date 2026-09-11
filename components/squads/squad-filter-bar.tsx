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
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-text-subtle font-medium mr-1">Filter by squad:</span>
      <button
        onClick={() => setFilter(null)}
        className={`flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
          !activeSquadId
            ? "bg-slate-800 text-white shadow-sm"
            : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
        }`}
      >
        All
      </button>
      {squads.map((squad) => (
        <button
          key={squad.id}
          onClick={() => setFilter(squad.id === activeSquadId ? null : squad.id)}
          className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all duration-150 ${
            activeSquadId === squad.id
              ? "text-white shadow-sm"
              : "bg-surface-inset text-text-secondary hover:bg-slate-200 hover:text-text-primary"
          }`}
          style={
            activeSquadId === squad.id
              ? { backgroundColor: squad.color }
              : {}
          }
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: activeSquadId === squad.id ? "rgba(255,255,255,0.7)" : squad.color }}
          />
          {squad.name}
        </button>
      ))}
    </div>
  );
}
