import { describe, expect, it } from "vitest";
import { prefersMarkdown } from "./markdown-negotiation";

describe("native Markdown for Agents negotiation", () => {
  it.each([
    ["text/markdown", true],
    ["TEXT/MARKDOWN; charset=utf-8", true],
    ["text/markdown, text/html;q=0.001", true],
    ["text/markdown;q=0.7, text/html;q=0.5", true],
    ["text/html;q=0.5, text/markdown;q=0.7", true],
    ["text/markdown;q=0, text/html", false],
    ["text/html;q=0.9, text/markdown;q=0.5", false],
    ["text/markdown, text/html", true],
    ["text/html, text/markdown", false],
    ["text/markdown;q=0, text/markdown;q=1, text/html;q=0.5", true],
    ["text/markdown;q=0.9, */*;q=1", true],
    ["text/*;q=1, text/markdown;q=0.9", true],
    ["text/markdown;q=0", false],
    ["text/markdown;q=0, text/*", false],
    ["text/markdown;q=bad, text/html", false],
    ["text/markdown;q=1.1", false],
    ["text/markdown;q=-1", false],
    ["text/markdown;q=0.1234", false],
    ["text/markdown;q=1;q=0", false],
    ["text/markdown;q", false],
    ["text/markdown;q=bad, text/markdown", false],
    ["text/html;q=bad, text/markdown;q=0.5", false],
    ["text/html;q=0.1234, text/markdown;q=0.01", false],
    ["text/html;q=1;q=0, text/markdown", false],
    ['text/html;q="1", text/markdown;q=0.5', false],
    ["text/html;q=1.1, text/markdown", false],
    ["text/html;q=-1, text/markdown", false],
    ["text/html;q, text/markdown", false],
    ["text/markdown, text/html;q=bad", false],
    ["text/html, application/xhtml+xml, */*;q=0.8", false],
    ["text/*", false],
    ["*/*", false],
    ["application/json", false],
    ["", false],
  ] as const)("selects Markdown for Accept %j only when preferred (%s)", (accept, expected) => {
    const request = new Request("https://metagraph.sh/", { headers: { accept } });
    expect(prefersMarkdown(request)).toBe(expected);
  });

  it("keeps HTML as the default when Accept is absent", () => {
    expect(prefersMarkdown(new Request("https://metagraph.sh/"))).toBe(false);
  });

  it.each(["GET", "HEAD", "POST", "PUT"])("negotiates only safe page method %s", (method) => {
    const request = new Request("https://metagraph.sh/", {
      method,
      headers: { accept: "text/markdown" },
    });
    expect(prefersMarkdown(request)).toBe(method === "GET" || method === "HEAD");
  });
});
