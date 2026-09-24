import { createHmac, timingSafeEqual } from "node:crypto";
export interface UpdatesToken {
  workspaceId: string;
  userId: string;
  upper: number;
  before: number;
  mode: "unread" | "week";
  baseline: string;
  readRevision: number;
  complete: boolean;
  expires?: number;
}
function signature(body: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Updates requires AUTH_SECRET");
  return createHmac("sha256", secret)
    .update(`workspace-updates:${body}`)
    .digest("base64url");
}
export function signUpdatesToken(value: UpdatesToken): string {
  const body = Buffer.from(
    JSON.stringify({
      ...value,
      expires: value.expires ?? Date.now() + 86400000,
    }),
  ).toString("base64url");
  return `${body}.${signature(body)}`;
}
export function readUpdatesToken(
  token: string,
  workspaceId: string,
  userId: string,
): UpdatesToken {
  if (token.length > 4096) throw new Error("Invalid snapshot");
  const [body, mac, extra] = token.split(".");
  const expected = signature(body ?? "");
  if (
    !body ||
    !mac ||
    extra ||
    mac.length !== expected.length ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  )
    throw new Error("Invalid snapshot");
  const data: UpdatesToken = JSON.parse(
    Buffer.from(body, "base64url").toString(),
  );
  if (
    data.workspaceId !== workspaceId ||
    data.userId !== userId ||
    !data.expires ||
    data.expires < Date.now() ||
    !Number.isSafeInteger(data.upper) ||
    data.upper < 0 ||
    !Number.isSafeInteger(data.before) ||
    data.before < 0 ||
    !Number.isSafeInteger(data.readRevision) ||
    data.readRevision < 0 ||
    !["unread", "week"].includes(data.mode) ||
    !Number.isFinite(Date.parse(data.baseline))
  )
    throw new Error("Invalid or expired snapshot; refresh Updates");
  return data;
}
