import { describe, expect, it } from "vitest"
import { chainGraphBenchEnabled, chainGraphEnabled } from "@/lib/chain-graph/flag"

describe("chainGraphEnabled", () => {
  it("is on in development and preview, and by explicit flag only elsewhere", () => {
    expect(chainGraphEnabled({ NODE_ENV: "development" })).toBe(true)
    expect(chainGraphEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(true)
    expect(chainGraphEnabled({ NODE_ENV: "production", COMPASS_CHAIN_GRAPH: "1" })).toBe(true)
    expect(chainGraphEnabled({ NODE_ENV: "production", VERCEL_ENV: "production" })).toBe(false)
    expect(chainGraphEnabled({ NODE_ENV: "production", COMPASS_CHAIN_GRAPH: "true" })).toBe(false)
    expect(chainGraphEnabled({ NODE_ENV: "production", COMPASS_CHAIN_GRAPH: " 1" })).toBe(false)
  })
  it("keeps the benchmark page off in preview", () => {
    expect(chainGraphBenchEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toBe(false)
    expect(chainGraphBenchEnabled({ NODE_ENV: "production", COMPASS_CHAIN_GRAPH_BENCH: "1" })).toBe(true)
    expect(chainGraphBenchEnabled({ NODE_ENV: "development" })).toBe(true)
  })
})
