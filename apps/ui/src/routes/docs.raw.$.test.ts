import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

const mockGetPage = vi.fn();
vi.mock("@/lib/docs-source", () => ({
  docsSource: { getPage: (...args: unknown[]) => mockGetPage(...args) },
}));

const { resolveRawMarkdown } = await import("./docs.raw.$");

describe("resolveRawMarkdown", () => {
  it("splits the splat into slugs and returns the page's processed markdown", async () => {
    const getText = vi.fn().mockResolvedValue("# Account Axon Removals\n");
    mockGetPage.mockReturnValue({ data: { getText } });

    const res = await resolveRawMarkdown("api-reference/accounts/account-axon-removals");

    expect(mockGetPage).toHaveBeenCalledWith([
      "api-reference",
      "accounts",
      "account-axon-removals",
    ]);
    expect(getText).toHaveBeenCalledWith("processed");
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    await expect(res.text()).resolves.toBe("# Account Axon Removals\n");
  });

  it("resolves an undefined splat (the docs index) as an empty slug array", async () => {
    mockGetPage.mockReturnValue({ data: { getText: vi.fn().mockResolvedValue("") } });

    await resolveRawMarkdown(undefined);

    expect(mockGetPage).toHaveBeenCalledWith([]);
  });

  it("throws TanStack Router's notFound() when no page matches the slug", async () => {
    mockGetPage.mockReturnValue(undefined);

    await resolveRawMarkdown("does/not/exist").then(
      () => expect.unreachable("should have thrown notFound()"),
      (err) => expect(isNotFound(err)).toBe(true),
    );
  });
});
