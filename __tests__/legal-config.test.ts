import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  AGENT_DATA_RETENTION_DAYS,
  AGENT_DATA_RETENTION_LABEL,
  LEGAL_CONTACT_EMAIL,
  LEGAL_GOVERNING_LAW_STATE,
  LEGAL_LAST_UPDATED,
  LEGAL_OPERATOR,
} from "@/lib/legal-config"

const root = process.cwd()
const read = (file: string) => readFileSync(path.join(root, file), "utf8")

describe("legal config", () => {
  it("carries the decided facts, with no placeholders left", () => {
    expect(LEGAL_OPERATOR).toBe("RB Code Labs LLC")
    expect(LEGAL_GOVERNING_LAW_STATE).toBe("Michigan")
    expect(LEGAL_CONTACT_EMAIL).toBe("privacy@rbcodelabs.com")
    expect(LEGAL_LAST_UPDATED).toBe("October 21, 2026")
    for (const value of [LEGAL_OPERATOR, LEGAL_GOVERNING_LAW_STATE, LEGAL_CONTACT_EMAIL, LEGAL_LAST_UPDATED]) {
      expect(value).not.toMatch(/\[|\]|TODO|placeholder/i)
    }
  })

  it("publishes the retention period it enforces", () => {
    expect(AGENT_DATA_RETENTION_DAYS).toBe(365)
    expect(AGENT_DATA_RETENTION_LABEL).toBe("one year")
  })

  it("leaves no bracketed placeholders or TODOs in the legal pages, config or footer", () => {
    for (const file of ["lib/legal-config.ts", "app/(marketing)/privacy/page.tsx", "app/(marketing)/terms/page.tsx", "components/marketing/legal-page.tsx", "components/marketing/marketing-footer.tsx"]) {
      const source = read(file)
      expect(source, file).not.toMatch(/TODO\(legal\)|\[STATE\]|\[[A-Z][A-Z _-]{2,}\]/)
    }
  })

  it("names the LLC wherever the operator is spelled out in prose", () => {
    for (const file of ["app/(marketing)/privacy/page.tsx", "app/(marketing)/terms/page.tsx", "components/marketing/marketing-footer.tsx"]) {
      expect(read(file), file).not.toMatch(/RB Code Labs(?! LLC)/)
    }
  })

  it("keeps the privacy policy honest about deletion and retention", () => {
    const privacy = read("app/(marketing)/privacy/page.tsx")
    expect(privacy).toContain("AGENT_DATA_RETENTION_LABEL")
    expect(privacy).not.toMatch(/do not currently apply an automatic retention period/)
    expect(privacy).toMatch(/Disconnecting Google Drive does not delete/)
    expect(privacy).toMatch(/Settings, Profile/)
    // Production runs on Supabase Postgres; Aurora DSQL is only some deployments.
    expect(privacy).toMatch(/<strong>Supabase<\/strong>/)
    expect(privacy).toMatch(/Aurora DSQL, the database that stores that data for some/)
    expect(privacy).not.toMatch(/the Aurora DSQL database that stores account and workspace data/)
    // Disclosed as outside the retention job: the agent audit log carries a truncated tool-input summary.
    expect(privacy).toMatch(/audit records of the actions the agent took/)
  })
})
