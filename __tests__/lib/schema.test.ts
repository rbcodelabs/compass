import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getActiveSchema } from "@/lib/schema";

describe("getActiveSchema", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Shallow-copy so mutations in each test don't leak
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns compass_dev when NODE_ENV=development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.VERCEL_ENV;
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_dev");
  });

  it("returns compass_preview when VERCEL_ENV=preview", () => {
    // NODE_ENV must not be "development" or the dev branch wins first
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "preview";
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_preview");
  });

  it("returns compass_prod when VERCEL_ENV=production", () => {
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_prod");
  });

  it("respects PGSCHEMA prefix override", () => {
    process.env.NODE_ENV = "development";
    process.env.PGSCHEMA = "myapp";
    expect(getActiveSchema()).toBe("myapp_dev");
  });

  it("falls back to compass_dev when no env hint is present", () => {
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_dev");
  });
});
