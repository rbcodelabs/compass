import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/lib/route-access";

describe("UI registry route access", () => {
  it("allows the exact registry route through the session proxy", () => {
    expect(isPublicPath("/ui")).toBe(true);
  });

  it("does not expose similarly prefixed product routes", () => {
    expect(isPublicPath("/ui-private")).toBe(false);
    expect(isPublicPath("/ui/components")).toBe(false);
  });
});

describe("chain graph benchmark route access", () => {
  it("allows only the exact synthetic benchmark route", () => {
    expect(isPublicPath("/chain-graph-bench")).toBe(true);
    expect(isPublicPath("/chain-graph-bench/x")).toBe(false);
    expect(isPublicPath("/acme/ws/graph")).toBe(false);
  });
});
