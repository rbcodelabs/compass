import { describe, it, expect } from "vitest";
import { getDoc } from "@/lib/docs";

describe("getDoc", () => {
  it("renders GFM pipe tables as HTML <table> markup, not raw pipe text", async () => {
    const doc = await getDoc("09-mcp-api");
    expect(doc).not.toBeNull();
    expect(doc!.html).toContain("<table>");
    expect(doc!.html).toContain("<th>");
    expect(doc!.html).toContain("<td>");
    // The raw markdown pipe-table syntax must not leak through as literal text
    expect(doc!.html).not.toMatch(/\|\s*Tool\s*\|\s*Description\s*\|/);
  });

  it("includes documented tool names as table cell content", async () => {
    const doc = await getDoc("09-mcp-api");
    expect(doc!.html).toContain("add_to_roadmap");
    expect(doc!.html).toContain("list_roadmap_items");
  });

  it("documents the required Streamable HTTP Accept header", async () => {
    const doc = await getDoc("09-mcp-api");
    expect(doc).not.toBeNull();
    expect(doc!.html).toContain("Accept: application/json, text/event-stream");
    expect(doc!.html).toContain("Content-Type: application/json");
    expect(doc!.html).toContain("Every <strong>POST</strong> request");
    expect(doc!.html).toContain("returns HTTP 406");
    expect(doc!.html).toContain("returns HTTP 415");
    expect(doc!.html).toContain("protocolVersion");
    expect(doc!.html).toContain("2025-11-25");
  });

  it("configures mcp-remote to send the workspace API key", async () => {
    const doc = await getDoc("09-mcp-api");
    expect(doc).not.toBeNull();
    expect(doc!.html).toContain('"--header"');
    expect(doc!.html).toContain("Authorization:${MCP_AUTH_HEADER}");
    expect(doc!.html).toContain('"MCP_AUTH_HEADER": "Bearer compass_your_api_key"');
    expect(doc!.html).not.toContain(
      '"MCP_AUTH_HEADER": "Authorization: Bearer compass_your_api_key"',
    );
  });
});
