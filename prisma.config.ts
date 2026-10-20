import { defineConfig } from "prisma/config";
import { getMigrationDatabaseUrl } from "./lib/db-url";

// This URL is ONLY used by Prisma CLI tooling (prisma migrate diff /
// aurora-dsql-prisma migrate) for SQL dialect detection.
// It is never used at runtime — connections are built via DsqlSigner in lib/db.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: getMigrationDatabaseUrl(process.env) ?? "postgresql://localhost/prisma",
  },
});
