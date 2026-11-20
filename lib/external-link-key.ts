import { createHash } from "node:crypto"

/** The full, provider-normalized identity stays in externalKey; this bounded ASCII key is indexable on DSQL. */
export function externalLinkKeyHash(externalKey: string): string {
  return createHash("sha256").update(externalKey, "utf8").digest("hex")
}
