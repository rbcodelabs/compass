import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Replace PrismaClient with a recorder so no engine or connection is created.
// Everything else (Prisma.defineExtension, error classes) stays real.
vi.mock("@prisma/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prisma/client")>()
  class RecordingClient {
    extensions: unknown[] = []
    $extends(extension: unknown) {
      this.extensions.push(extension)
      return this
    }
  }
  return { ...actual, PrismaClient: RecordingClient }
})

import { createPrismaClient } from "./db"
import { retryReadsExtension } from "./db-retry"

const extensionsOf = () => (createPrismaClient() as unknown as { extensions: unknown[] }).extensions

describe("read retry is DSQL-only", () => {
  beforeEach(() => {
    // Hermetic: automation previews forbid DATABASE_URL and would throw in the plain-Postgres cases.
    vi.stubEnv("PREVIEW_AUTOMATION_ENABLED", "")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("does not attach the retry extension on plain Postgres (DATABASE_URL)", () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/compass")
    expect(extensionsOf()).not.toContain(retryReadsExtension)
  })

  it("does not attach the retry extension on plain Postgres (POSTGRES_URL fallback)", () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("POSTGRES_URL", "postgres://u:p@localhost:6543/compass")
    expect(extensionsOf()).not.toContain(retryReadsExtension)
  })

  it("attaches the retry extension on the DSQL path", () => {
    vi.stubEnv("DATABASE_URL", "")
    vi.stubEnv("POSTGRES_URL", "")
    vi.stubEnv("PGHOST", "cluster.dsql.us-east-1.on.aws")
    vi.stubEnv("AWS_REGION", "us-east-1")
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/test")
    expect(extensionsOf()).toContain(retryReadsExtension)
  })
})
