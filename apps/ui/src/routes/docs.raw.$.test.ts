import { describe, expect, it, vi } from "vitest";

const mockGetPage = vi.fn();
vi.mock("@/lib/docs-source", () => ({
  docsSource: { getPage: (...args: unknown[]) => mockGetPage(...args) },
}));

const { resolveRawMarkdown } = await import("./docs.raw.$");

// The response policy itself is covered by lib/metagraphed/raw-markdown.test.ts.
// What is only true HERE is the wiring: this route reads the DOCS collection,
// and it answers as the docs section.
describe("docs /docs/raw/$", () => {
  it("resolves against docsSource and returns its processed markdown", async () => {
    const getText = vi.fn().mockResolvedValue("# Account Axon Removals\n");
    mockGetPage.mockReturnValue({ data: { getText } });

    const res = await resolveRawMarkdown("api-reference/accounts/account-axon-removals");

    expect(mockGetPage).toHaveBeenCalledWith([
      "api-reference",
      "accounts",
      "account-axon-removals",
    ]);
    expect(getText).toHaveBeenCalledWith("processed");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("# Account Axon Removals\n");
  });

  it("answers 404 for a path that is not a docs page", async () => {
    mockGetPage.mockReturnValue(undefined);
    const res = await resolveRawMarkdown("does/not/exist");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("No docs page at");
  });
});
