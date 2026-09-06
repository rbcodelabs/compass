import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getActiveSchema } from "@/lib/schema";

function setNodeEnv(value: string | undefined) {
  const mutableEnv = process.env as Record<string, string | undefined>;
  if (value === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = value;
}

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
    setNodeEnv("development");
    delete process.env.VERCEL_ENV;
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_dev");
  });

  it("returns compass_preview when VERCEL_ENV=preview", () => {
    setNodeEnv("production");
    process.env.VERCEL_ENV = "preview";
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_preview");
  });

  it("returns compass_prod when VERCEL_ENV=production", () => {
    setNodeEnv("production");
    process.env.VERCEL_ENV = "production";
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_prod");
  });

  it("respects PGSCHEMA prefix override", () => {
    setNodeEnv("development");
    process.env.PGSCHEMA = "myapp";
    expect(getActiveSchema()).toBe("myapp_dev");
  });

  it("falls back to compass_dev when no env hint is present", () => {
    setNodeEnv(undefined);
    delete process.env.VERCEL_ENV;
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_dev");
  });

  it("PGSCHEMA override works for preview env", () => {
    setNodeEnv("production");
    process.env.VERCEL_ENV = "preview";
    process.env.PGSCHEMA = "myapp";
    expect(getActiveSchema()).toBe("myapp_preview");
  });

  it("PGSCHEMA override works for production env", () => {
    setNodeEnv("production");
    process.env.VERCEL_ENV = "production";
    process.env.PGSCHEMA = "myapp";
    expect(getActiveSchema()).toBe("myapp_prod");
  });

  it("development env takes precedence over VERCEL_ENV=preview", () => {
    // NODE_ENV=development wins even if VERCEL_ENV is set
    setNodeEnv("development");
    process.env.VERCEL_ENV = "preview";
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_dev");
  });

  it("unknown VERCEL_ENV falls back to dev", () => {
    setNodeEnv("production");
    process.env.VERCEL_ENV = "staging"; // not a recognized value
    delete process.env.PGSCHEMA;
    expect(getActiveSchema()).toBe("compass_dev");
  });

  it("isolates enabled previews by numeric PR and immutable revision", () => {
    process.env.PREVIEW_AUTOMATION_ENABLED = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_GIT_PULL_REQUEST_ID = "156";
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    expect(getActiveSchema()).toBe("compass_pr_156_aaaaaaaaaaaa");
  });

  it.each([undefined, "", "../prod", "0"])("fails closed for invalid PR metadata %s", (pr) => {
    process.env.PREVIEW_AUTOMATION_ENABLED = "1";
    process.env.VERCEL_ENV = "preview";
    if (pr === undefined) delete process.env.VERCEL_GIT_PULL_REQUEST_ID;
    else process.env.VERCEL_GIT_PULL_REQUEST_ID = pr;
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    expect(() => getActiveSchema()).toThrow(/preview/i);
  });

  it("does not enable automation schemas outside preview", () => {
    process.env.PREVIEW_AUTOMATION_ENABLED = "1";
    process.env.VERCEL_ENV = "production";
    expect(() => getActiveSchema()).toThrow(/preview/i);
  });
});
