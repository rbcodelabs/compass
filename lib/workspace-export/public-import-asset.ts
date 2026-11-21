import type { BlobAdapters } from "./blobs"
import type { ImportOptions } from "./import"

export async function copyPublicImportAsset(
  blobs: Pick<BlobAdapters, "putPublic" | "fetchPublic">,
  journal: NonNullable<ImportOptions["journal"]>,
  logical: string, bytes: Uint8Array, contentType: string, hostname: string,
  providerIO: NonNullable<ImportOptions["providerIO"]> = io => io(),
): Promise<string> {
  const physical = await journal.reserve("feedback", logical, bytes)
  const expected = new URL("https://" + hostname)
  expected.pathname = "/" + physical
  const url = await providerIO(() => blobs.putPublic(physical, bytes, contentType))
  if (url !== expected.href) throw new Error("Public import asset location differs from the reservation")
  const stored = await providerIO(() => blobs.fetchPublic(url))
  if (!stored || !Buffer.from(bytes).equals(stored.bytes)) throw new Error("Public import asset verification failed")
  await journal.verify("feedback", logical, physical)
  return url
}
