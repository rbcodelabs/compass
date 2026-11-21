import { describe, expect, it } from "vitest"
import { createInspectionPool } from "@/lib/migrations/inspection-pool"

describe("inspection connection configuration", () => {
  it("preserves the original IAM callback in a real pg.Pool without a DSQL startup statement timeout", async () => {
    const password = async () => "synthetic-iam-token"
    const pool = createInspectionPool({ host: "synthetic.dsql.example", password, ssl: true, statement_timeout: 99 }, false)
    try {
      expect(pool.options.password).toBe(password)
      expect(Object.keys(pool.options)).not.toContain("password")
      expect(pool.options.ssl).toBe(true)
      expect(pool.options).not.toHaveProperty("statement_timeout")
      expect(pool.options.query_timeout).toBe(2000)
    } finally { await pool.end() }
  })

  it("uses a server statement timeout only for plain PostgreSQL", async () => {
    const pool = createInspectionPool({ connectionString: "postgresql://postgres:postgres@localhost/compass_e2e" }, true)
    try { expect(pool.options.statement_timeout).toBe(2000) } finally { await pool.end() }
  })
})
