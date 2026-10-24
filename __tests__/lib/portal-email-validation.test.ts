import { describe, it, expect } from "vitest";
import { isValidPortalEmail } from "@/lib/portal-email";
import { escapeHtml } from "@/lib/html-escape";

describe("isValidPortalEmail", () => {
  it.each(["jane@example.com", "Jane.Doe+tag@sub.example.co.uk", "o'brien@example.com", "a_b-c@x-y.io"])(
    "accepts %s",
    (email) => {
      expect(isValidPortalEmail(email)).toBe(true);
    }
  );

  it.each([
    "",
    "no-at-sign",
    "a@b",
    "a b@example.com",
    "<img src=x onerror=alert(1)>@example.com",
    "a<script>@example.com",
    'a"b@example.com',
    "a&b@example.com",
    "a`b@example.com",
    "a@exa<mple.com",
    "a@@example.com",
    `${"a".repeat(250)}@example.com`,
  ])("rejects %s", (email) => {
    expect(isValidPortalEmail(email)).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("jane@example.com")).toBe("jane@example.com");
  });
});
