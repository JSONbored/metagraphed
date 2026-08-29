import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const OPENAPI_CHUNK = /\/assets\/openapi-page-[^/]+\.js(?:\?|$)/;

function recordOpenAPIChunks(page: Parameters<typeof gotoThroughRestart>[0]): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (OPENAPI_CHUNK.test(request.url())) requests.push(request.url());
  });
  return requests;
}

test.describe("content route runtime isolation", () => {
  test("a hand-written guide does not load the API-reference renderer", async ({ page }) => {
    const openapiChunks = recordOpenAPIChunks(page);
    await gotoThroughRestart(page, "/docs/mcp");
    await expect(page.getByRole("heading", { name: "MCP", level: 1 })).toBeVisible();
    expect(openapiChunks).toEqual([]);
  });

  test("a digest does not load the API-reference renderer", async ({ page }) => {
    const openapiChunks = recordOpenAPIChunks(page);
    await gotoThroughRestart(page, "/news/sn19/2026-w17");
    await expect(page.getByRole("heading", { name: /Subnet 19.*2026-W17/i })).toBeVisible();
    expect(openapiChunks).toEqual([]);
  });

  test("an API-reference page resolves its isolated renderer", async ({ page }) => {
    const openapiChunks = recordOpenAPIChunks(page);
    await gotoThroughRestart(page, "/docs/api-reference/subnets/subnets-by-network");
    await expect(page.getByRole("heading", { name: "Subnets By Network" })).toBeVisible();
    await expect(
      page.getByText("/api/v1/{network}/subnets", { exact: false }).first(),
    ).toBeVisible();
    await expect.poll(() => openapiChunks.length).toBe(1);
  });
});
