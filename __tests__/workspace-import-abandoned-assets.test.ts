import { expect, it, vi } from "vitest"
import { reclaimAbandonedAsset } from "@/lib/workspace-export/abandoned-assets"

it("continues sweeping an uncertain PUT even after an earlier deletion saw no object", async () => {
  let present = false
  const del = vi.fn(async () => { present = false })
  const adapter = { provider: "disk", namespace: "host:volume", remove: del }
  const record = { physicalKey: "attempt/key", provider: "disk", namespace: "host:volume", state: "reserved" as const }
  expect(await reclaimAbandonedAsset(record, adapter)).toBe("pending")
  present = true
  expect(await reclaimAbandonedAsset(record, adapter)).toBe("pending")
  expect(present).toBe(false)
  expect(await reclaimAbandonedAsset({ ...record, state: "verified" }, adapter)).toBe("cleaned")
  expect(await reclaimAbandonedAsset(record, { ...adapter, namespace: "other" })).toBe("pending")
  expect(del).toHaveBeenCalledTimes(3)
})
