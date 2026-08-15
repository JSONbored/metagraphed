import { describe, expect, it, vi } from "vitest";
import {
  type MarkdownPageSource,
  rawMarkdownLink,
  rawMarkdownPath,
  rawMarkdownResponse,
} from "./raw-markdown";

function sourceWith(markdown: string | null, getText = vi.fn().mockResolvedValue(markdown ?? "")) {
  const getPage = vi.fn(() => (markdown === null ? undefined : { data: { getText } }));
  return { source: getPage as unknown as MarkdownPageSource["getPage"], getPage, getText };
}

describe("rawMarkdownPath", () => {
  it("inserts raw/ after the section", () => {
    expect(rawMarkdownPath("docs", "api-reference/accounts/account-balance")).toBe(
      "/docs/raw/api-reference/accounts/account-balance",
    );
    expect(rawMarkdownPath("news", "sn38/2026-w25")).toBe("/news/raw/sn38/2026-w25");
  });

  it("resolves the section index to the bare raw path", () => {
    // /docs and /news are real pages in both collections, so their twin is a
    // real URL too -- not `/docs/raw/` with a trailing segment of nothing.
    expect(rawMarkdownPath("docs", undefined)).toBe("/docs/raw");
    expect(rawMarkdownPath("docs", "")).toBe("/docs/raw");
    expect(rawMarkdownPath("news", "/")).toBe("/news/raw");
  });

  it("collapses empty segments rather than emitting a doubled slash", () => {
    expect(rawMarkdownPath("docs", "/mcp/")).toBe("/docs/raw/mcp");
    expect(rawMarkdownPath("docs", "a//b")).toBe("/docs/raw/a/b");
  });
});

describe("rawMarkdownLink", () => {
  it("is an absolute alternate link typed as markdown", () => {
    // Absolute, not site-relative: this tag is read by crawlers that may have
    // fetched the HTML from a cache or a proxy with no base to resolve against.
    expect(rawMarkdownLink("docs", "mcp")).toStrictEqual({
      rel: "alternate",
      type: "text/markdown",
      href: "https://metagraph.sh/docs/raw/mcp",
      title: "This page as plain markdown",
    });
  });
});

describe("rawMarkdownResponse", () => {
  it("splits the splat into slugs and returns the page's processed markdown", async () => {
    const { source, getPage, getText } = sourceWith("# Account Balance\n");

    const res = await rawMarkdownResponse(
      { getPage: source },
      "docs",
      "api-reference/accounts/account-balance",
    );

    expect(getPage).toHaveBeenCalledWith(["api-reference", "accounts", "account-balance"]);
    expect(getText).toHaveBeenCalledWith("processed");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    await expect(res.text()).resolves.toBe("# Account Balance\n");
  });

  it("resolves an undefined splat (the section index) as an empty slug array", async () => {
    const { source, getPage } = sourceWith("");
    await rawMarkdownResponse({ getPage: source }, "news", undefined);
    expect(getPage).toHaveBeenCalledWith([]);
  });

  it("answers 404 -- NOT 500, and not a thrown notFound() -- when no page matches", async () => {
    // The regression this file exists for. The resolver used to
    // `throw notFound()`, which a server route handler has no boundary to
    // catch, so production answered 500 with an HTML error page for
    // /docs/raw/index and every other unknown path. The old test asserted
    // isNotFound(err) and passed the whole time.
    const { source } = sourceWith(null);

    const res = await rawMarkdownResponse({ getPage: source }, "docs", "does/not/exist");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    // An absence must not be cached: the page may exist after the next deploy.
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("/docs/raw/does/not/exist");
    // Point the reader at the index rather than leaving them at a dead end.
    expect(body).toContain("https://metagraph.sh/docs/llms.txt");
  });

  it("names the section it was asked for in the 404", async () => {
    const { source } = sourceWith(null);
    const body = await (
      await rawMarkdownResponse({ getPage: source }, "news", "sn0/1999-w01")
    ).text();
    expect(body).toContain("No news page at");
    expect(body).toContain("https://metagraph.sh/news/llms.txt");
  });

  it("marks both the hit and the miss noindex", async () => {
    // The twin is the same content as the HTML page, which is the one in the
    // sitemap. Two indexable copies is the duplicate-content bet #11204 records
    // this site losing once already.
    const hit = sourceWith("# Page\n");
    const miss = sourceWith(null);
    for (const res of [
      await rawMarkdownResponse({ getPage: hit.source }, "docs", "mcp"),
      await rawMarkdownResponse({ getPage: miss.source }, "docs", "nope"),
    ]) {
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    }
  });

  it("lets an agent that walks the whole section cache between pages", async () => {
    const { source } = sourceWith("# Page\n");
    const res = await rawMarkdownResponse({ getPage: source }, "docs", "mcp");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("cache-control")).toContain("stale-while-revalidate");
  });
});
