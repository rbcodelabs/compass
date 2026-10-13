import { describe, expect, it } from "vitest"
import { csvCell, csvFilenameStem, toCsv } from "@/lib/csv"

describe("csvCell", () => {
  it("leaves plain text alone and renders null/undefined as empty", () => {
    expect(csvCell("hello")).toBe("hello")
    expect(csvCell(null)).toBe("")
    expect(csvCell(undefined)).toBe("")
  })

  it("quotes cells containing commas, quotes or newlines, doubling embedded quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"')
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"')
  })

  it("neutralises spreadsheet formula triggers in strings", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvCell("+1")).toBe("'+1")
    expect(csvCell("-1")).toBe("'-1")
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)")
    expect(csvCell("\tcmd")).toBe("'\tcmd")
  })

  it("does not mangle real numbers, including negatives, and drops non-finite ones", () => {
    expect(csvCell(-3)).toBe("-3")
    expect(csvCell(0)).toBe("0")
    expect(csvCell(12.5)).toBe("12.5")
    expect(csvCell(Number.NaN)).toBe("")
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("")
  })

  it("renders booleans as true/false", () => {
    expect(csvCell(true)).toBe("true")
    expect(csvCell(false)).toBe("false")
  })
})

describe("toCsv", () => {
  it("emits a BOM, CRLF line endings and a trailing newline", () => {
    const csv = toCsv(["A", "B"], [["1", "x,y"]])
    expect(csv).toBe("﻿A,B\r\n1,\"x,y\"\r\n")
  })

  it("emits just the header for no rows", () => {
    expect(toCsv(["A"], [])).toBe("﻿A\r\n")
  })
})

describe("csvFilenameStem", () => {
  it("slugs names and strips header-unsafe characters", () => {
    expect(csvFilenameStem('Q3 priorities / "v2"', "x")).toBe("q3-priorities-v2")
  })

  it("falls back when nothing usable remains", () => {
    expect(csvFilenameStem("日本語", "round")).toBe("round")
    expect(csvFilenameStem("", "round")).toBe("round")
  })
})
