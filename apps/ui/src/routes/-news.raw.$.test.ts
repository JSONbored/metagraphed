import { describe, expect, it, vi } from "vitest";

const mockGetPage = vi.fn();
vi.mock("@/lib/news-source", () => ({
  newsSource: { getPage: (...args: unknown[]) => mockGetPage(...args) },
}));

const { resolveRawMarkdown } = await import("./news.raw.$");

// Mirror of docs.raw.$.test.ts: the shared policy is tested once in
// lib/metagraphed/raw-markdown.test.ts, and what this pins is that the digests'
// route reads the NEWS collection rather than the docs one -- the copy-paste
// error that would otherwise serve /news/raw/sn38/2026-w25 a 404 forever.
describe("news /news/raw/$", () => {
  it("resolves against newsSource and returns its processed markdown", async () => {
    const getText = vi.fn().mockResolvedValue("# Subnet 38 — 2026-W25\n");
    mockGetPage.mockReturnValue({ data: { getText } });

    const res = await resolveRawMarkdown("sn38/2026-w25");

    expect(mockGetPage).toHaveBeenCalledWith(["sn38", "2026-w25"]);
    expect(getText).toHaveBeenCalledWith("processed");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("# Subnet 38 — 2026-W25\n");
  });

  it("answers 404 for a week that was never published", async () => {
    mockGetPage.mockReturnValue(undefined);
    const res = await resolveRawMarkdown("sn38/1999-w01");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No news page at");
  });
});
