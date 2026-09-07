import { expect, it } from "vitest"
import { generateKeyPairSync } from "node:crypto"
import { signLease, verifyLease } from "../scripts/preview-automation/lease"
import { signGrant } from "../scripts/preview-automation/contracts"
it("caps bootstrap grant expiry at the lease minus the full run lifetime", () => {
  const { privateKey } = generateKeyPairSync("ed25519")
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const input = { deploymentId: "dpl_test", origin: "https://test.vercel.app", runId: "a", operation: "bootstrap" as const }
  const token = signGrant(input, key, 1000, 1050)
  expect(JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).exp).toBe(1050)
  expect(() => signGrant(input, key, 1000, 1000)).toThrow()
})
it("requires a signed matching lease with a full run lifetime remaining", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub = publicKey.export({ type: "spki", format: "pem" }).toString()
  const target = { schema: "compass_pr_1_aaaaaaaaaaaa", deploymentId: "dpl_test", origin: "https://test.vercel.app" }
  const token = signLease({ ...target, expiresAt: 7200000 }, priv)
  expect(() => verifyLease(token, pub, target, 0)).not.toThrow()
  expect(() => verifyLease(token, pub, target, 4000000)).toThrow()
  expect(() => verifyLease(token, pub, { ...target, deploymentId: "dpl_other" }, 0)).toThrow()
  expect(() => verifyLease(`${token}bad`, pub, target, 0)).toThrow()
})
