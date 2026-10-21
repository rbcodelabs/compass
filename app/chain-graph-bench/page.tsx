import { notFound } from "next/navigation"
import { connection } from "next/server"
import type { Metadata } from "next"
import { ChainGraphView } from "@/components/chain-graph/chain-graph-view"
import { chainGraphBenchEnabled } from "@/lib/chain-graph/flag"
import { syntheticChainGraph } from "@/lib/chain-graph/synthetic"

export const metadata: Metadata = { title: "Chain graph benchmark", robots: { index: false, follow: false } }

/** Synthetic-data harness for the renderer benchmark (scripts/chain-graph-bench.mjs). No database, no session; 404 unless enabled. */
export default async function ChainGraphBenchPage({ searchParams }: { searchParams: Promise<{ n?: string; collapsed?: string; limit?: string }> }) {
  // The flag is read from the runtime environment, so opt out of build-time prerendering (otherwise a build without it bakes in the 404).
  await connection()
  if (!chainGraphBenchEnabled()) notFound()
  const { n, collapsed, limit } = await searchParams
  const size = Math.min(Math.max(Number.parseInt(n ?? "1000", 10) || 1000, 10), 5000)
  const graph = syntheticChainGraph(size)
  return (
    <div className="h-screen p-3">
      <ChainGraphView graph={graph} benchHooks elementLimit={limit === "off" ? Number.POSITIVE_INFINITY : undefined} initialCollapse={collapsed === "all" ? "all" : collapsed === "none" ? "none" : "default"} />
    </div>
  )
}
