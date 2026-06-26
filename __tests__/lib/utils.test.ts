import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn (className merger)", () => {
  it("returns a single class unchanged", () => {
    expect(cn("foo")).toBe("foo");
  });

  it("joins multiple classes with a space", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("returns empty string when called with no arguments", () => {
    expect(cn()).toBe("");
  });

  it("ignores falsy conditional values", () => {
    expect(cn("foo", false && "bar", null, undefined, "baz")).toBe("foo baz");
  });

  it("handles object syntax (clsx-style)", () => {
    expect(cn({ foo: true, bar: false, baz: true })).toBe("foo baz");
  });

  it("merges conflicting Tailwind classes — last wins", () => {
    // tailwind-merge resolves conflicts: p-2 wins over p-4
    expect(cn("p-4", "p-2")).toBe("p-2");
  });

  it("merges conflicting text color classes", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("merges conflicting background classes", () => {
    expect(cn("bg-red-500", "bg-green-300")).toBe("bg-green-300");
  });

  it("does not merge non-conflicting Tailwind classes", () => {
    const result = cn("flex", "items-center", "p-4");
    expect(result).toContain("flex");
    expect(result).toContain("items-center");
    expect(result).toContain("p-4");
  });

  it("handles array inputs (clsx-style)", () => {
    expect(cn(["foo", "bar"], "baz")).toBe("foo bar baz");
  });

  it("handles conditional object with truthy numeric value", () => {
    expect(cn({ active: 1 as unknown as boolean })).toBe("active");
  });

  it("trims extra whitespace from concatenated classes", () => {
    // clsx handles this; result should not have leading/trailing spaces
    const result = cn("foo", "bar");
    expect(result.trim()).toBe(result);
  });
});
