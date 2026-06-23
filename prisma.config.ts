import { defineConfig } from "prisma/config";

// This URL is ONLY used by Prisma CLI tooling (prisma migrate diff /
// aurora-dsql-prisma migrate) for SQL dialect detection.
// It is never used at runtime — connections are built via DsqlSigner in lib/db.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost/prisma",
  },
});
