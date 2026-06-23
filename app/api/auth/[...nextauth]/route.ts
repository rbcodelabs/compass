import { handlers } from "@/auth";

// Force Node.js runtime — Prisma adapter and DSQL signer require Node.js APIs.
// Without this, Next.js defaults to Edge runtime which lacks the adapter.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
