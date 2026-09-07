import { sign, verify } from "node:crypto"
type Target = { schema: string; deploymentId: string; origin: string }
export function signLease(lease: Target & { expiresAt: number }, privateKey: string) {
  const payload = Buffer.from(JSON.stringify({ kind: "provision-lease", ...lease })).toString("base64url")
  return `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`
}
export function verifyLease(token: string, publicKey: string, target: Target, now = Date.now()) {
  const [payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra || !verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url"))) throw new Error("Invalid provisioning lease")
  const lease = JSON.parse(Buffer.from(payload, "base64url").toString())
  // Five minutes covers metadata/bootstrap/network setup before the one-hour server session begins.
  if (lease.kind !== "provision-lease" || lease.schema !== target.schema || lease.deploymentId !== target.deploymentId || lease.origin !== target.origin || !Number.isFinite(lease.expiresAt) || lease.expiresAt - now < 3900_000) throw new Error("Provisioning lease does not cover this run")
  return { expiresAt: lease.expiresAt as number }
}
