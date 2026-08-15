import { describe, expect, it } from "vitest";
import { llmsIndexBody, llmsIndexHeaders } from "./llms-index";

const INDEX = [
  "# Docs",
  "",
  "- [MCP](/docs/mcp): the registry as MCP tools",
  "- Group",
  "  - [Subnets](/docs/api-reference/subnets)",
  "",
].join("\n");

const DOCS = {
  index: INDEX,
  section: "docs",
  origin: "https://metagraph.sh",
  title: "Metagraphed documentation",
  example: "mcp",
} as const;

describe("llmsIndexBody", () => {
  it("absolutizes the loader's site-relative links against the request origin", () => {
    // A fumadocs loader's baseUrl makes index() emit "/docs/mcp", which is
    // fine in-app and useless in a plain-text file a machine fetches with no
    // page context to resolve it against.
    const body = llmsIndexBody(DOCS);
    expect(body).toContain("[MCP](https://metagraph.sh/docs/mcp)");
    expect(body).toContain("[Subnets](https://metagraph.sh/docs/api-reference/subnets)");
    expect(body).not.toMatch(/\]\(\/docs/);
  });

  it("uses the request's own origin, so dev and preview deploys are correct too", () => {
    const body = llmsIndexBody({ ...DOCS, origin: "http://localhost:3000" });
    expect(body).toContain("[MCP](http://localhost:3000/docs/mcp)");
    expect(body).toContain("http://localhost:3000/docs/raw/mcp");
  });

  it("replaces the loader's hardcoded heading with the section's own title", () => {
    // fumadocs' llms() emits "# Docs" for EVERY collection, so the digests'
    // index introduced 285 weekly digests as the documentation.
    const body = llmsIndexBody({
      ...DOCS,
      section: "news",
      title: "Metagraphed weekly subnet digests",
      example: "sn38/2026-w25",
    });
    expect(body.split("\n")[0]).toBe("# Metagraphed weekly subnet digests");
    expect(body).not.toContain("# Docs");
  });

  it("states the markdown-twin rule directly under the H1", () => {
    const lines = llmsIndexBody(DOCS).split("\n");
    expect(lines[0]).toBe("# Metagraphed documentation");
    expect(lines[1]).toBe("");
    // The llms.txt shape is H1, one blockquote summary, then the details. A
    // note buried below 349 link lines is a note nothing reads.
    expect(lines[2]!.startsWith("> ")).toBe(true);
    expect(lines[2]).toContain("https://metagraph.sh/docs/raw/mcp");
  });

  it("keeps every entry the loader emitted", () => {
    // The note is inserted, never a replacement: dropping entries from the
    // index is the failure that would be silent.
    for (const line of INDEX.split("\n").slice(2)) {
      if (!line.trim()) continue;
      const expected = line.replace("](/", "](https://metagraph.sh/");
      expect(llmsIndexBody(DOCS)).toContain(expected);
    }
  });

  it("titles and annotates an index the loader gave no heading", () => {
    const body = llmsIndexBody({ ...DOCS, index: "- [MCP](/docs/mcp)" });
    const lines = body.split("\n");
    expect(lines[0]).toBe("# Metagraphed documentation");
    expect(lines[2]!.startsWith("> ")).toBe(true);
    expect(body).toContain("[MCP](https://metagraph.sh/docs/mcp)");
  });

  it("names the section it was built for", () => {
    const body = llmsIndexBody({
      ...DOCS,
      index: "# Docs",
      section: "news",
      title: "News",
      example: "sn38/2026-w25",
    });
    expect(body).toContain("`/news/`");
    expect(body).toContain("https://metagraph.sh/news/raw/sn38/2026-w25");
  });
});

describe("llmsIndexHeaders", () => {
  it("serves plain text, cacheable between requests", () => {
    const headers = new Headers(llmsIndexHeaders());
    expect(headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(headers.get("cache-control")).toContain("max-age=300");
  });
});
